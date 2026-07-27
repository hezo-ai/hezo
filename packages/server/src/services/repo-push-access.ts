import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { logger } from '../logger';
import { type FetchFn, parseGitHubUrl, validateRepoAccess } from './github';

const log = logger.child('repo-push-access');

export interface PushAccessDeps {
	db: Db;
	/** Optional so a deployment shape without a vault simply skips the check. */
	masterKeyManager?: MasterKeyManager;
}

/**
 * Re-check whether the repo's connected GitHub account can push to it, and
 * record the answer on `repos.can_push`.
 *
 * Linking a repo only proves *read* access — a read-only collaborator, and
 * anyone at all on a public repo, gets a 200 from the repo endpoint — so write
 * access has to be read from that response's `permissions` object. Without it
 * the gap first surfaces as a denied push mid-run, where it is easily mistaken
 * for Hezo scoping git per repo (it does not: one account-level SSH key and one
 * account-wide OAuth token serve every linked repo).
 *
 * Called whenever we already hold the token — repo setup, retry, reclone, and
 * the admin git-state panel — so a permission change made on GitHub after
 * linking is picked up rather than staying pinned to link-time truth.
 *
 * Best-effort and never throws: on a locked master key, a missing connection, a
 * network failure, or an inconclusive API status, the stored value is left as
 * it was and returned unchanged. Only a definitive answer overwrites it — the
 * `permissions.push` boolean on a 200, or a hard 403/404 denial (an account
 * that cannot even see the repo certainly cannot push to it).
 */
export async function refreshRepoPushAccess(
	deps: PushAccessDeps,
	repoId: string,
): Promise<boolean | null> {
	const { db, masterKeyManager } = deps;

	const repoRes = await db.query<{
		repo_identifier: string;
		oauth_connection_id: string | null;
		can_push: boolean | null;
	}>('SELECT repo_identifier, oauth_connection_id, can_push FROM repos WHERE id = $1', [repoId]);
	const repo = repoRes.rows[0];
	if (!repo) return null;

	const stored = repo.can_push;
	if (!repo.oauth_connection_id) return stored;

	const parsed = parseGitHubUrl(repo.repo_identifier);
	if (!parsed) return stored;

	const token = await loadConnectionAccessToken(deps, repo.oauth_connection_id);
	if (!token) return stored;

	let canPush: boolean | null;
	try {
		const access = await validateRepoAccess(parsed.owner, parsed.repo, token, timeBoundedFetch);
		if (access.accessible) {
			canPush = access.canPush;
		} else if (access.status === 403 || access.status === 404) {
			canPush = false;
		} else {
			// Rate limit, 5xx, anything else — inconclusive, so don't overwrite a
			// known-good answer with a transient one.
			return stored;
		}
	} catch (e) {
		log.warn(`push-access check for ${repo.repo_identifier} failed`, (e as Error).message);
		return stored;
	}

	if (canPush === null || canPush === stored) return stored;

	await db.query('UPDATE repos SET can_push = $1 WHERE id = $2', [canPush, repoId]);
	log.info(`push access for ${repo.repo_identifier}: ${canPush ? 'write' : 'read-only'}`);
	return canPush;
}

/**
 * This check is a convenience, never a dependency — callers run it on paths a user
 * or an agent is waiting behind. A GitHub that hangs must surface as "unknown, keep
 * what we had" within seconds, not stall the caller on the default socket timeout.
 */
const PUSH_ACCESS_CHECK_TIMEOUT_MS = 10_000;

const timeBoundedFetch: FetchFn = (input, init) =>
	fetch(input, { ...init, signal: AbortSignal.timeout(PUSH_ACCESS_CHECK_TIMEOUT_MS) });

/** Decrypt an OAuth connection's access token. Null when the vault is locked or the row is gone. */
async function loadConnectionAccessToken(
	deps: PushAccessDeps,
	oauthConnectionId: string,
): Promise<string | null> {
	const key = deps.masterKeyManager?.getKey();
	if (!key) return null;
	const result = await deps.db.query<{ encrypted_value: string }>(
		`SELECT s.encrypted_value
		 FROM oauth_connections oc
		 JOIN secrets s ON s.id = oc.access_token_secret_id
		 WHERE oc.id = $1`,
		[oauthConnectionId],
	);
	if (result.rows.length === 0) return null;
	const { decrypt } = await import('../crypto/encryption');
	return decrypt(result.rows[0].encrypted_value, key);
}

import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { type CommitMergeVerdict, checkCommitMerged, type FetchFn, parseGitHubUrl } from './github';

/**
 * Asking a repo's git host something from the server side, with the repo's own
 * connected credential.
 *
 * These calls run **outside the egress proxy** - Hezo makes them itself rather than
 * an agent making them through the substituting proxy - so the rule in AGENTS.md
 * applies in full: the destination may not be agent-influenceable, and nothing
 * derived from the credential may be returned. Both hold structurally here. The host
 * is `getApiBaseUrl()`, a constant; only `owner`/`repo` path segments vary, and they
 * come from `parseGitHubUrl`, whose charset admits no host or path escape. Every
 * function returns a verdict, never an upstream body.
 */
export interface RepoGitHubDeps {
	db: Db;
	/** Optional so a deployment shape without a vault simply skips the call. */
	masterKeyManager?: MasterKeyManager;
}

/** A repo resolved to everything one host-side API call needs. */
export interface RepoGitHubTarget {
	owner: string;
	repo: string;
	token: string;
	fetchFn: FetchFn;
}

/**
 * These calls are always a convenience, never a dependency - callers run them on
 * paths a user or a finishing run is waiting behind. A host that hangs must surface
 * as "unknown, keep what we had" within seconds rather than stalling the caller on
 * the default socket timeout.
 */
export const GITHUB_CHECK_TIMEOUT_MS = 10_000;

export const timeBoundedFetch: FetchFn = (input, init) =>
	fetch(input, { ...init, signal: AbortSignal.timeout(GITHUB_CHECK_TIMEOUT_MS) });

/**
 * Resolve a repo row to a callable target, or null when the call cannot be made at
 * all: no linked connection, an identifier that is not a GitHub repo, a locked
 * vault, or a connection whose secret is gone. Null is "did not ask", which every
 * caller must keep distinct from anything the host actually said.
 */
export async function resolveRepoGitHub(
	deps: RepoGitHubDeps,
	repoId: string,
): Promise<RepoGitHubTarget | null> {
	const res = await deps.db.query<{
		repo_identifier: string;
		oauth_connection_id: string | null;
	}>('SELECT repo_identifier, oauth_connection_id FROM repos WHERE id = $1', [repoId]);
	const row = res.rows[0];
	if (!row?.oauth_connection_id) return null;

	const parsed = parseGitHubUrl(row.repo_identifier);
	if (!parsed) return null;

	const token = await loadConnectionAccessToken(deps, row.oauth_connection_id);
	if (!token) return null;

	return { owner: parsed.owner, repo: parsed.repo, token, fetchFn: timeBoundedFetch };
}

/**
 * Whether a commit this instance pushed was merged into the repo.
 *
 * Answers `unknown` for every reason the question could not be put - no connection,
 * a locked vault, a host that would not say - so a caller can never read "we did not
 * ask" as "nobody merged it".
 */
export async function checkRepoCommitMerged(
	deps: RepoGitHubDeps,
	repoId: string,
	sha: string,
): Promise<CommitMergeVerdict> {
	const target = await resolveRepoGitHub(deps, repoId);
	if (!target) return 'unknown';
	return checkCommitMerged(target.owner, target.repo, sha, target.token, target.fetchFn);
}

/** Decrypt an OAuth connection's access token. Null when the vault is locked or the row is gone. */
export async function loadConnectionAccessToken(
	deps: RepoGitHubDeps,
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

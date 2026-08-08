import { logger } from '../logger';
import { validateRepoAccess } from './github';
import { type RepoGitHubDeps, resolveRepoGitHub } from './repo-github';

const log = logger.child('repo-push-access');

export type PushAccessDeps = RepoGitHubDeps;

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
	const { db } = deps;

	const repoRes = await db.query<{ can_push: boolean | null }>(
		'SELECT can_push FROM repos WHERE id = $1',
		[repoId],
	);
	if (repoRes.rows.length === 0) return null;
	const stored = repoRes.rows[0].can_push;

	const target = await resolveRepoGitHub(deps, repoId);
	if (!target) return stored;
	const name = `${target.owner}/${target.repo}`;

	let canPush: boolean | null;
	try {
		const access = await validateRepoAccess(
			target.owner,
			target.repo,
			target.token,
			target.fetchFn,
		);
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
		log.warn(`push-access check for ${name} failed`, (e as Error).message);
		return stored;
	}

	if (canPush === null || canPush === stored) return stored;

	await db.query('UPDATE repos SET can_push = $1 WHERE id = $2', [canPush, repoId]);
	log.info(`push access for ${name}: ${canPush ? 'write' : 'read-only'}`);
	return canPush;
}

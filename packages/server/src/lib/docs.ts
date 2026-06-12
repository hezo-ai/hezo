import { join } from 'node:path';

/**
 * Resolve the absolute path to a project repo's AGENTS.md.
 * AGENTS.md is the only doc that remains filesystem-based (git-tracked in the repo).
 */
export function resolveAgentsMdPath(
	dataDir: string,
	teamSlug: string,
	projectSlug: string,
	repoName: string,
): string {
	return join(dataDir, 'teams', teamSlug, 'projects', projectSlug, repoName, 'AGENTS.md');
}

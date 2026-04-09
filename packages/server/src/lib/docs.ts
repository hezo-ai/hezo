import { join } from 'node:path';

/**
 * Resolve the absolute path to a project repo's AGENTS.md.
 * AGENTS.md is the only doc that remains filesystem-based (git-tracked in the repo).
 */
export function resolveAgentsMdPath(
	dataDir: string,
	companySlug: string,
	projectSlug: string,
	repoShortName: string,
): string {
	return join(
		dataDir,
		'companies',
		companySlug,
		'projects',
		projectSlug,
		repoShortName,
		'AGENTS.md',
	);
}

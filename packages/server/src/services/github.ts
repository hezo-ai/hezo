/**
 * Pure URL parsing utilities for GitHub repos. The OAuth-driven API
 * functions (org listing, repo creation, deploy-key registration) were
 * removed in P5 — agents now drive deploy-key onboarding through the
 * `setup_github_repo` MCP tool, and clones happen over SSH against the
 * per-run signing socket.
 */

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
	const trimmed = url.trim().replace(/\.git$/, '');

	const sshMatch = trimmed.match(/^git@github\.com:([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/);
	if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

	const httpsMatch = trimmed.match(
		/^(?:https?:\/\/)?github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/?$/,
	);
	if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

	const shortMatch = trimmed.match(/^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/);
	if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };

	return null;
}

// Build the web URL for a repository from its `owner/repo` identifier. Returns
// null for hosts we don't have a web-URL mapping for.
export function repoWebUrl(identifier: string, hostType: string): string | null {
	if (hostType !== 'github') return null;
	const trimmed = identifier.trim();
	if (!trimmed) return null;
	return `https://github.com/${trimmed}`;
}

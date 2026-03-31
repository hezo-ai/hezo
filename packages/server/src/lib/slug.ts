export function toSlug(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

export function toIssuePrefix(companyName: string): string {
	const words = companyName.trim().split(/\s+/);
	if (words.length === 1) {
		return words[0].substring(0, 4).toUpperCase();
	}
	return words
		.map((w) => w[0])
		.join('')
		.toUpperCase();
}

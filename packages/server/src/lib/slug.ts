export function toSlug(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

export async function uniqueSlug(
	base: string,
	existsFn: (slug: string) => Promise<boolean>,
): Promise<string> {
	if (!(await existsFn(base))) return base;
	let n = 2;
	while (await existsFn(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

export function toProjectIssuePrefix(projectName: string): string {
	const cleaned = projectName.trim().replace(/[^a-zA-Z0-9\s]/g, '');
	const words = cleaned.split(/\s+/).filter(Boolean);
	if (words.length === 0) return 'P';
	if (words.length === 1) {
		return words[0].substring(0, 2).toUpperCase();
	}
	return words
		.map((w) => w[0])
		.join('')
		.substring(0, 4)
		.toUpperCase();
}

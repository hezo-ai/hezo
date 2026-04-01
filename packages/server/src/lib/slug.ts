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

const MENTION_RE = /(?<![\w@])@([a-z0-9][\w-]*)/gi;
const FENCED_CODE_RE = /(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?(?:```|~~~)(?=\n|$)/g;
const INLINE_CODE_RE = /`[^`]*`/g;

export function extractMentionSlugs(content: unknown): string[] {
	const text = flattenTextFields(content);
	if (!text) return [];
	const stripped = text.replace(FENCED_CODE_RE, ' ').replace(INLINE_CODE_RE, ' ');
	const slugs = new Set<string>();
	MENTION_RE.lastIndex = 0;
	let match = MENTION_RE.exec(stripped);
	while (match !== null) {
		slugs.add(match[1].toLowerCase());
		match = MENTION_RE.exec(stripped);
	}
	return Array.from(slugs);
}

function flattenTextFields(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value !== 'object') return String(value);
	const parts: string[] = [];
	for (const v of Object.values(value as Record<string, unknown>)) {
		parts.push(flattenTextFields(v));
	}
	return parts.join('\n');
}

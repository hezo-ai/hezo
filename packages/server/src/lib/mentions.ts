const MENTION_RE = /(?<![\w@])@([a-z0-9][\w-]*)/gi;
const FENCED_CODE_RE = /(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?(?:```|~~~)(?=\n|$)/g;
const INLINE_CODE_RE = /`[^`]*`/g;
// Captures a slug behind one or two leading @ — i.e. both active (@slug) and
// passive (@@slug) references, so a deliberately-linked name is never flagged.
const LINKED_MENTION_RE = /(?<![\w@])@@?([a-z0-9][\w-]*)/gi;

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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Flags teammate slugs that are addressed in the comment by bold or bare name
 * rather than a mention prefix, so nothing notifies the named teammate. Detects
 * the two unambiguous addressing forms — an emphasised name (`**slug**` /
 * `__slug__`) and a leading-line address (`slug —` / `slug:`) — while leaving
 * ordinary prose references untouched. A name already carrying an `@` or `@@`
 * prefix is deliberate and never flagged.
 */
export function detectUnlinkedTeammateReferences(content: unknown, knownSlugs: string[]): string[] {
	const text = flattenTextFields(content);
	if (!text) return [];
	const stripped = text.replace(FENCED_CODE_RE, ' ').replace(INLINE_CODE_RE, ' ');

	const linked = new Set<string>();
	LINKED_MENTION_RE.lastIndex = 0;
	let linkedMatch = LINKED_MENTION_RE.exec(stripped);
	while (linkedMatch !== null) {
		linked.add(linkedMatch[1].toLowerCase());
		linkedMatch = LINKED_MENTION_RE.exec(stripped);
	}

	const flagged = new Set<string>();
	for (const rawSlug of knownSlugs) {
		const slug = rawSlug.toLowerCase();
		if (linked.has(slug)) continue;
		const s = escapeRegExp(slug);
		// Emphasised name: **slug** or __slug__, not already @-prefixed.
		const bold = new RegExp(String.raw`(?<!@)(\*\*|__)${s}\1`, 'i');
		// Leading-line address: start of a line, the bare name, an addressing
		// separator (em/en dash, hyphen, colon, comma), then whitespace or EOL.
		const lead = new RegExp(String.raw`(?:^|\n)\s*${s}\s*[—–\-:,](?:\s|$)`, 'i');
		if (bold.test(stripped) || lead.test(stripped)) flagged.add(slug);
	}
	return Array.from(flagged);
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

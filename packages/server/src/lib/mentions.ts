const MENTION_RE = /(?<![\w@])@([a-z0-9][\w-]*)/gi;
const FENCED_CODE_RE = /(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?(?:```|~~~)(?=\n|$)/g;
const INLINE_CODE_RE = /`[^`]*`/g;
// Captures a slug behind one or two leading @ — i.e. both active (@slug) and
// passive (@@slug) references, so a deliberately-linked name is never flagged.
const LINKED_MENTION_RE = /(?<![\w@])@@?([a-z0-9][\w-]*)/gi;

// Directed-ask signals — text that reads as a request aimed at the reader rather
// than a statement about them: a second-person pronoun (`you`/`your`/`yourself`,
// which also covers `you're`/`you'll` via the word boundary), an imperative
// request opener, or a question mark.
const ASK_INTENT_RES: RegExp[] = [
	/\b(?:you|your|yourself)\b/i,
	/\b(?:please|kindly|ptal)\b/i,
	/\?/,
];

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

/**
 * Flags teammate slugs addressed with the PASSIVE mention form (`@@slug`) where
 * the surrounding text reads like an ask — an active `@slug` was almost certainly
 * intended, yet `@@` links without notifying, so the handoff stalls silently. To
 * avoid warning on a deliberate passive reference, a slug is flagged only when it
 * is BOTH addressed (a leading-line `@@slug —` or an emphasised `**@@slug**`) AND
 * its address paragraph carries a directed-ask signal (see ASK_INTENT_RES). A slug
 * that is also actively `@`-mentioned anywhere is never flagged — it already
 * notifies. Mirrors detectUnlinkedTeammateReferences for the passive form.
 */
export function detectPassiveTeammateAsks(content: unknown, knownSlugs: string[]): string[] {
	const text = flattenTextFields(content);
	if (!text) return [];
	const stripped = text.replace(FENCED_CODE_RE, ' ').replace(INLINE_CODE_RE, ' ');

	// A slug reached by an active @mention already notifies, so it never warns.
	const active = new Set(extractMentionSlugs(stripped));

	const flagged = new Set<string>();
	for (const rawSlug of knownSlugs) {
		const slug = rawSlug.toLowerCase();
		if (active.has(slug)) continue;
		const s = escapeRegExp(slug);
		// Addressed by the passive form: emphasised `**@@slug**`/`__@@slug__` or a
		// leading-line `@@slug —` — the @@-prefixed analogue of the sibling's forms.
		const bold = new RegExp(String.raw`(\*\*|__)@@${s}\1`, 'i');
		const lead = new RegExp(String.raw`(?:^|\n)\s*@@${s}\s*[—–\-:,](?:\s|$)`, 'i');
		if (!bold.test(stripped) && !lead.test(stripped)) continue;
		// Only warn when the paragraph(s) carrying this passive mention read as an
		// ask — scoped to those paragraphs so a `you` elsewhere never leaks in.
		const block = passiveMentionParagraphs(stripped, s);
		if (block && ASK_INTENT_RES.some((re) => re.test(block))) flagged.add(slug);
	}
	return Array.from(flagged);
}

/** The blank-line-delimited paragraph(s) of `stripped` that contain `@@<slug>`. */
function passiveMentionParagraphs(stripped: string, escapedSlug: string): string {
	const mentionRe = new RegExp(String.raw`(?<![\w@])@@${escapedSlug}\b`, 'i');
	return stripped
		.split(/\n\s*\n/)
		.filter((p) => mentionRe.test(p))
		.join('\n');
}

/**
 * Flags teammate slugs addressed with the UNLINKED form — bold (`**slug**` /
 * `__slug__`) or a leading-line address (`slug —` / `slug:`), no `@` prefix at
 * all — where the surrounding text reads like an ask, so an active `@slug` was
 * almost certainly intended yet the bare/bold name renders as inert text and
 * wakes no one, stranding the handoff silently. This is the auto-actionable
 * subset of detectUnlinkedTeammateReferences: it adds the same directed-ask gate
 * detectPassiveTeammateAsks uses (see ASK_INTENT_RES) so a bold name written for
 * mere emphasis or attribution is never promoted. A slug also reached by an
 * active `@`-mention anywhere is skipped — it already notifies. The runner's
 * handoff-delivery net feeds these to promoteUnlinkedTeammateAsks so the named
 * teammate is actually woken.
 */
export function detectUnlinkedTeammateAsks(content: unknown, knownSlugs: string[]): string[] {
	const text = flattenTextFields(content);
	if (!text) return [];
	const stripped = text.replace(FENCED_CODE_RE, ' ').replace(INLINE_CODE_RE, ' ');

	// A slug reached by an active @mention already notifies, so it never warns.
	const active = new Set(extractMentionSlugs(stripped));

	const flagged = new Set<string>();
	for (const rawSlug of knownSlugs) {
		const slug = rawSlug.toLowerCase();
		if (active.has(slug)) continue;
		const s = escapeRegExp(slug);
		// Emphasised name (**slug**/__slug__, not already @-prefixed) or a
		// leading-line address (`slug —`/`slug:`) — mirrors the two unambiguous
		// addressing forms detectUnlinkedTeammateReferences recognises.
		const bold = new RegExp(String.raw`(?<!@)(\*\*|__)${s}\1`, 'i');
		const lead = new RegExp(String.raw`(?:^|\n)\s*${s}\s*[—–\-:,](?:\s|$)`, 'i');
		if (!bold.test(stripped) && !lead.test(stripped)) continue;
		// Only warn when the paragraph(s) carrying this address read as an ask —
		// scoped to those paragraphs so a `you` elsewhere never leaks in.
		const block = unlinkedMentionParagraphs(stripped, s);
		if (block && ASK_INTENT_RES.some((re) => re.test(block))) flagged.add(slug);
	}
	return Array.from(flagged);
}

/**
 * The blank-line-delimited paragraph(s) of `stripped` that address `escapedSlug`
 * by the unlinked bold or leading-line form (no `@` prefix).
 */
function unlinkedMentionParagraphs(stripped: string, escapedSlug: string): string {
	const bold = new RegExp(String.raw`(?<!@)(\*\*|__)${escapedSlug}\1`, 'i');
	const lead = new RegExp(String.raw`(?:^|\n)\s*${escapedSlug}\s*[—–\-:,](?:\s|$)`, 'i');
	return stripped
		.split(/\n\s*\n/)
		.filter((p) => bold.test(p) || lead.test(p))
		.join('\n');
}

/**
 * Upgrades the unlinked bold/leading-line ADDRESS forms of the given slugs to an
 * active `@`-mention so the teammate is woken when the text is posted as a
 * comment: `**slug**` → `**@slug**`, and a leading-line `slug —` → `@slug —`.
 * Only the addressing occurrences are rewritten — an ordinary mid-prose mention
 * of the same name (which never matched the address forms) is left untouched, and
 * emphasis is preserved. Pass exactly the slugs detectUnlinkedTeammateAsks
 * flagged; a name already carrying an `@` is never touched.
 */
export function promoteUnlinkedTeammateAsks(text: string, slugs: string[]): string {
	let out = text;
	for (const rawSlug of slugs) {
		const s = escapeRegExp(rawSlug.toLowerCase());
		// Emphasised address: **slug**/__slug__ (not already @-prefixed) → **@slug**.
		out = out.replace(new RegExp(String.raw`(?<!@)(\*\*|__)(${s})\1`, 'gi'), '$1@$2$1');
		// Leading-line address: `slug —`/`slug:` at line start → `@slug —`.
		out = out.replace(
			new RegExp(String.raw`((?:^|\n)[ \t]*)(${s})(\s*[—–\-:,](?:\s|$))`, 'gi'),
			'$1@$2$3',
		);
	}
	return out;
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

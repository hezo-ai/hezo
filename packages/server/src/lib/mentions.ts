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

// Action-assignment phrases — a line that *assigns* work to the teammate it
// names ("Required actions for X", "Action items — X", "Next steps for X")
// rather than merely naming them. Compound phrases only, so attribution lines
// ("Actions taken by X", "Findings from X") never match.
const ACTION_ASSIGNMENT_RE =
	/\b(?:required actions?|actions? required|action items?|action list|next steps?|to-?dos?|follow-?ups?)\b/i;

// A leading-line address may follow a short routing label — `Next step:`,
// `Handoff:`, `Owner:` — so a handoff like `Next step: captain — …` addresses the
// captain even though the name isn't the first token on the line. The label is a
// bounded run of non-colon characters up to a colon, with optional trailing
// markdown emphasis (`**`/`*`/`_`, so `**Next step:**` matches) before the
// space(s) separating it from the name. Bounded (≤48 chars, single line) so a
// sentence carrying an incidental colon can't reach across and swallow a
// mid-sentence name.
const ADDRESS_LABEL_PREFIX = String.raw`(?:[^\n:]{0,48}:[*_]*[ \t]+)?`;

/**
 * The "leading-line address" matcher for a name pattern (a bare `slug` or the
 * passive `@@slug`): the name at the start of a line — optionally after a routing
 * label (see ADDRESS_LABEL_PREFIX) — followed by an addressing separator (em/en
 * dash, hyphen, colon, comma) then whitespace or EOL. Shared by every detector so
 * the unlinked and passive forms recognise the same addressing shapes.
 */
function leadingAddressRegex(namePattern: string): RegExp {
	return new RegExp(
		String.raw`(?:^|\n)\s*${ADDRESS_LABEL_PREFIX}${namePattern}\s*[—–\-:,](?:\s|$)`,
		'i',
	);
}

/**
 * The "action-assignment line" matcher for a name pattern (a bare `slug` or the
 * passive `@@slug`), shared by both ask-gated detectors: a markdown heading
 * (`## …`), a fully-bold line (`**…**`), or a colon-terminated label line that
 * both contains the teammate reference and carries an action-assignment phrase
 * (see ACTION_ASSIGNMENT_RE). Such a line assigns work to the teammate it names
 * — typically introducing an imperative list — so the phrase itself is the ask
 * signal; the imperative items below rarely carry the second-person/`please`/`?`
 * signals the paragraph gate needs, which is how the shape
 * `## Required actions for @@slug` + numbered list evades the other forms.
 */
function hasActionAssignmentLine(stripped: string, namePattern: string): boolean {
	const nameRe = new RegExp(namePattern, 'i');
	for (const rawLine of stripped.split('\n')) {
		const line = rawLine.trim();
		if (!ACTION_ASSIGNMENT_RE.test(line) || !nameRe.test(line)) continue;
		const isHeading = /^#{1,6}\s/.test(line);
		const isBoldLine = /^(?:\*\*|__).*(?:\*\*|__):?$/.test(line);
		const isLabelLine = /:$/.test(line);
		if (isHeading || isBoldLine || isLabelLine) return true;
	}
	return false;
}

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
		// Leading-line address: start of a line (optionally after a routing label),
		// the bare name, an addressing separator, then whitespace or EOL.
		const lead = leadingAddressRegex(s);
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
		// Action-assignment line: `## Required actions for @@slug` — the phrase on
		// the line is itself the ask signal, no paragraph gate needed. The trailing
		// guard keeps a slug from matching inside a longer hyphenated slug
		// (`@@qa` in `@@qa-engineer`).
		if (hasActionAssignmentLine(stripped, String.raw`(?<![\w@])@@${s}(?![\w-])`)) {
			flagged.add(slug);
			continue;
		}
		// Addressed by the passive form: emphasised `**@@slug**`/`__@@slug__` or a
		// leading-line `@@slug —` — the @@-prefixed analogue of the sibling's forms.
		const bold = new RegExp(String.raw`(\*\*|__)@@${s}\1`, 'i');
		const lead = leadingAddressRegex(`@@${s}`);
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
 * wakes no one, stranding the handoff silently. This is the precise, ask-gated
 * subset of detectUnlinkedTeammateReferences: it adds the same directed-ask gate
 * detectPassiveTeammateAsks uses (see ASK_INTENT_RES) so a bold name written for
 * mere emphasis or attribution is never flagged. A slug also reached by an
 * active `@`-mention anywhere is skipped — it already notifies. The runner's
 * handoff-delivery net uses these to warn (in the run log) that a run ended with a
 * stranded bold-name handoff, mirroring create_comment's interactive warning.
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
		// Action-assignment line with the bare name: `## Required actions for slug`
		// — the phrase on the line is itself the ask signal, no paragraph gate
		// needed. The lookbehind keeps `@slug`/`@@slug` out (handled elsewhere) and,
		// with the trailing guard, keeps a slug from matching inside a longer
		// hyphenated slug (`engineer` in `qa-engineer` / `engineer-lead`).
		if (hasActionAssignmentLine(stripped, String.raw`(?<![\w@-])${s}(?![\w-])`)) {
			flagged.add(slug);
			continue;
		}
		// Emphasised name (**slug**/__slug__, not already @-prefixed) or a
		// leading-line address (`slug —`/`slug:`, optionally after a routing label)
		// — mirrors the addressing forms detectUnlinkedTeammateReferences recognises.
		const bold = new RegExp(String.raw`(?<!@)(\*\*|__)${s}\1`, 'i');
		const lead = leadingAddressRegex(s);
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
	const lead = leadingAddressRegex(escapedSlug);
	return stripped
		.split(/\n\s*\n/)
		.filter((p) => bold.test(p) || lead.test(p))
		.join('\n');
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

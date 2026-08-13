const MENTION_RE = /(?<![\w@])@([a-z0-9][\w-]*)/gi;
const FENCED_CODE_RE = /(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?(?:```|~~~)(?=\n|$)/g;
const INLINE_CODE_RE = /`[^`]*`/g;
// Captures a slug behind one or two leading @ — i.e. both active (@slug) and
// passive (@@slug) references, so a deliberately-linked name is never flagged.
const LINKED_MENTION_RE = /(?<![\w@])@@?([a-z0-9][\w-]*)/gi;
// Passive references only (@@slug) — the deliberate "name them, don't wake them"
// token. Used to report what a comment named without notifying.
const PASSIVE_MENTION_RE = /(?<![\w@])@@([a-z0-9][\w-]*)/gi;

/**
 * Directed-ask vocabulary — the ONE table every ask gate in this module reads.
 * A new phrasing belongs here as a single row; it must never become a new
 * positional branch on a detector (see detectPassiveTeammateAsks for why the
 * position/intent split is what put this module on a treadmill).
 *
 * Two groups, kept in one list because every caller wants both:
 *
 *  - **Explicit request signals** — text aimed at the reader rather than a
 *    statement about them: a second-person pronoun (`you`/`your`/`yourself`,
 *    which also covers `you're`/`you'll` via the word boundary), an imperative
 *    request opener, or a question mark.
 *  - **Baton-passing signals** — a handoff written as a status line rather than
 *    a request. SHARED_INSTRUCTIONS already treats this shape as an ask ("ready
 *    for review", "ready to merge", "over to you"), but its grammar carries no
 *    imperative opener, no second-person pronoun and no question mark, so the
 *    request signals alone never fire on it. That is how a report's *closing
 *    handoff block* — the one part whose entire job is to wake people — slips
 *    through when its lines are passive: `@@captain — verification confirms
 *    PASS. The document is ready for the admin.` reads as a status recap and
 *    wakes no one. (`over to you` / `back to you` need no pattern; the pronoun
 *    covers them.)
 */
const DIRECTED_ASK_RES: RegExp[] = [
	// -- Explicit request signals --------------------------------------------
	/\b(?:you|your|yourself)\b/i,
	/\b(?:please|kindly|ptal)\b/i,
	/\?/,
	// -- Baton-passing signals -----------------------------------------------
	// "ready for review", "ready for the admin", "ready to merge/ship/publish"
	/\bready\s+(?:for|to)\b/i,
	// "all yours", "the call is yours" — `yours` escapes the `your` pronoun
	// pattern above, whose word boundary stops at the `s`.
	/\byours\b/i,
	// "handing this back", "handed off to the captain", "hand it over"
	/\bhand(?:ing|ed|s)?\s+(?:this|it|these|them|off|over|back)\b/i,
	// "passing this to marketing", "passed it back", "passing the draft along" —
	// the same verb class as `hand …` above, which alone missed the `pass` form.
	/\bpass(?:ing|ed|es)?\s+(?:this|it|these|them|the\s+\w+)\s+(?:to|over|back|along)\b/i,
	// "take it from here", "takes it from here"
	/\btak(?:e|es|ing)\s+it\s+from\s+here\b/i,
	// The gate-word forms of the same handoff, which name the thing being waited
	// on instead of the person: "awaiting review", "awaiting final sign-off",
	// "for review", "pending approval", "sign-off needed". `ready for review`
	// above only covers the variant that opens with `ready`; a closing handoff
	// block just as often drops it ("@@marketing-lead — for review.").
	/\bawaiting\s+(?:\w+\s+){0,2}(?:review|approval|sign-?off|feedback|confirmation|decision)\b/i,
	/\b(?:for|pending)\s+(?:your\s+)?(?:review|approval|sign-?off|feedback|confirmation|decision)\b/i,
	/\bsign-?off\s+(?:needed|required|requested)\b/i,
	/\b(?:needs|requires)\s+(?:your\s+)?sign-?off\b/i,
];

/**
 * Whether text sitting next to a teammate reference reads as a directed ask.
 * Shared by every ask gate so the passive and unlinked forms — and the
 * sentence-scoped gate below — recognise exactly the same intent.
 */
function readsAsAsk(block: string): boolean {
	return DIRECTED_ASK_RES.some((re) => re.test(block));
}

// Sentence boundary: terminal punctuation followed by whitespace, or a line
// break. `.` inside a filename (`stock-JOBY.md is verified`) is NOT a boundary
// because the lookbehind requires whitespace after it, so an entity reference
// never splits a sentence away from its own ask.
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/;

/**
 * REFERENTIAL frames — the closed set of grammatical shapes in which naming a
 * teammate is attribution rather than an ask.
 *
 * This is the one place spending vocabulary is principled, and the asymmetry is
 * the whole point: the ways to *ask* someone to do something are unbounded (which
 * is why enumerating them put this module on a treadmill), but the ways to merely
 * *refer to* someone are few and grammatically marked — a preposition in front, a
 * possessive, or a past-tense reporting verb behind. Enumerating the safe set is
 * finite work; enumerating the unsafe set is not.
 *
 * Used only to veto the sentence-scoped gate, so a sentence that credits one
 * teammate while instructing the reader ("as @@architect noted, you should keep
 * the interface stable") does not warn about the teammate it merely cites.
 */
const REFERENTIAL_LEAD_RE = String.raw`(?:per|as|by|from|via|with|cc|about|regarding)\s+(?:the\s+)?`;
const REFERENTIAL_TRAIL_RE = String.raw`(?:['’]s\b|\s+(?:noted|note|said|says|confirmed|reported|reports|found|flagged|raised|approved|reviewed|verified|shipped|wrote|added|asked|mentioned|observed|recommended|identified|completed|delivered)\b)`;

/** Whether every occurrence of `namePattern` in `sentence` sits in a referential frame. */
function isPurelyReferential(sentence: string, namePattern: string): boolean {
	const any = new RegExp(namePattern, 'gi');
	const referential = new RegExp(
		`(?:${REFERENTIAL_LEAD_RE}${namePattern})|(?:${namePattern}${REFERENTIAL_TRAIL_RE})`,
		'gi',
	);
	const total = (sentence.match(any) ?? []).length;
	if (total === 0) return false;
	return (sentence.match(referential) ?? []).length >= total;
}

/** The sentence(s) of `stripped` containing a match for `namePattern`. */
function sentencesContaining(stripped: string, namePattern: string): string[] {
	const nameRe = new RegExp(namePattern, 'i');
	return stripped.split(SENTENCE_SPLIT_RE).filter((s) => nameRe.test(s));
}

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

// The sign-off/approval OBJECT of a gated handoff — the thing an approver grants.
const SIGNOFF_OBJECT_RE = String.raw`(?:sign-?\s?offs?|approvals?|reviews?)`;
// Gate words that put a NAMED approver on the hook for the sign-off object that
// follows them: "awaiting <name> sign-off", "needs the <name>'s approval",
// "pending <name> review", "for <name> sign-off", "waiting on <name> approval".
const SIGNOFF_GATE_LEAD_RE = String.raw`(?:awaiting|await|pending|needs?|needing|requires?|requiring|for|blocked\s+on|waiting\s+(?:on|for))`;
// Pending-action verbs the named approver must still perform — "<name> to sign
// off", "<name> must approve", "<name> still needs to review". The verb list is
// the ACTION, gated below by a REQUIRED modal so a past/granted "<name> approved
// …" (no modal) is never matched.
const SIGNOFF_PENDING_ACTION_RE = String.raw`(?:sign-?\s?off|approve|review)`;

/**
 * Whether `stripped` binds the teammate named by `namePattern` DIRECTLY to a
 * sign-off/approval gate — the mid-sentence handoff the address-position forms
 * (bold, leading-line, action-assignment line) all miss because the name sits
 * inside the sentence rather than opening a line. Two binding directions:
 *
 *   - gate → name → object:  "awaiting Captain sign-off", "needs the
 *     marketing-lead's approval", "pending Captain review", "for Captain sign-off".
 *   - name → pending action:  "Captain to sign off", "Captain must approve",
 *     "Captain still needs to review" — the modal ("to"/"must"/"needs to"/…) is
 *     REQUIRED, so a past/granted "Captain approved the plan" is NOT flagged.
 *
 * The binding of the name to the gate is itself the ask signal, so this needs no
 * separate readsAsAsk pass. It fires ONLY when the name is bound to the gate,
 * never when a gate word merely co-occurs with a non-addressed name elsewhere in
 * the sentence ("The doc went out for review last week; the architect wrote the
 * brief." → no match).
 *
 * Shared by BOTH ask-gated detectors, so the bare name (`for marketing-lead
 * review`) and the passive form (`for @@marketing-lead review`) are recognised as
 * the same handoff — neither wakes anyone. `namePattern` therefore carries its own
 * left-edge guard (a `(?<![\w@…])` lookbehind) rather than relying on a `\b` here:
 * a leading `\b` cannot match in front of the passive form's `@@`, which is how a
 * mid-sentence `@@slug` sign-off gate went unflagged.
 */
function hasNameBoundSignoffGate(stripped: string, namePattern: string): boolean {
	const gateNameObject = new RegExp(
		String.raw`\b${SIGNOFF_GATE_LEAD_RE}\s+(?:the\s+)?${namePattern}(?:['’]s)?\s+${SIGNOFF_OBJECT_RE}\b`,
		'i',
	);
	const namePendingAction = new RegExp(
		String.raw`${namePattern}(?:['’]s)?\s+(?:(?:still\s+)?(?:needs?|has)\s+to\s+|to\s+|must\s+|should\s+)${SIGNOFF_PENDING_ACTION_RE}\b`,
		'i',
	);
	return gateNameObject.test(stripped) || namePendingAction.test(stripped);
}

/**
 * Whether the ACTIVE `@slug` in `stripped` is itself ADDRESSING the teammate —
 * the same four shapes the two ask detectors below recognise, applied to the
 * active spelling instead of `@@slug`/the bare name.
 *
 * This is what exempts a slug from those detectors, and the scope is the point.
 * The exemption used to be comment-wide ("a slug reached by an active @mention
 * already notifies"), which is true about NOTIFICATION and false about the
 * ADDRESS FORM — the thing the detectors actually check. A name dropped
 * mid-sentence as a back-reference does notify, but it does not make a passive
 * line-opening address elsewhere correct, and under the wide rule it silenced
 * the warning on it. That made a slug's treatment depend on unrelated text: two
 * teammates written in the identical stranded form warned differently because
 * one happened to be name-dropped in passing.
 *
 * The miss this was written for: `@@admin — optionally disable <setting>.` +
 * `… since the earlier @admin ZIP request wasn't replied to.` The leading-line
 * branch flags the first line on sight, and never ran — the second line's
 * throwaway mention put `admin` in the exempt set. It also lands a real admin
 * inbox row, so the wake receipt read `woke: ['admin']` and every other net
 * (the runner's handoff warning, the no-wake exit check) stood down too.
 */
function hasActiveAddressingMention(stripped: string, slug: string): boolean {
	const s = escapeRegExp(slug);
	const namePattern = String.raw`(?<![\w@])@${s}(?![\w-])`;
	if (hasActionAssignmentLine(stripped, namePattern)) return true;
	if (leadingAddressRegex(`@${s}`).test(stripped)) return true;
	if (hasNameBoundSignoffGate(stripped, namePattern)) return true;
	return sentencesContaining(stripped, namePattern).some(
		(sentence) => readsAsAsk(sentence) && !isPurelyReferential(sentence, namePattern),
	);
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

/**
 * The passive (`@@slug`) teammate references in `content` — the slugs the text
 * deliberately names WITHOUT waking. The exact complement of
 * {@link extractMentionSlugs}, which is who actually gets woken; together they
 * let a write report what it did instead of guessing what it meant.
 */
export function extractPassiveMentionSlugs(content: unknown): string[] {
	const text = flattenTextFields(content);
	if (!text) return [];
	const stripped = text.replace(FENCED_CODE_RE, ' ').replace(INLINE_CODE_RE, ' ');
	const slugs = new Set<string>();
	PASSIVE_MENTION_RE.lastIndex = 0;
	let match = PASSIVE_MENTION_RE.exec(stripped);
	while (match !== null) {
		slugs.add(match[1].toLowerCase());
		match = PASSIVE_MENTION_RE.exec(stripped);
	}
	return Array.from(slugs);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The noun that marks a mention token as the *thing being discussed* rather than
// a reference to the teammate: "the @admin mention in TASK-7", "the @architect
// ping I sent". Deliberately narrow — `mentioned`/`pinged` are excluded because
// "@admin mentioned that …" narrates the *person speaking* (whose fix is the
// passive `@@`), not the mention token (whose fix is backticks).
const MENTION_NOUN_RE_SRC = String.raw`(?:@-)?(?:mention|ping)s?`;

// In the token-then-noun order, narrated position also requires a determiner in
// front of the token — "the @admin mention", "an unanswered @architect ping" —
// with room for up to two adjectives in between. Without that anchor an ordinary
// imperative ask using one of the nouns as a *verb* ("@admin ping me when you're
// back") would read as narration and warn on a perfectly good wake. Adjacency is
// what does the work: the determiner run must reach the token through whole
// words only, so a determiner elsewhere in the sentence ("check the doc? @admin
// ping me") can't anchor it.
const NARRATED_DETERMINER_RE_SRC = String.raw`\b(?:the|an?|that|this|these|those|your|my|our|their|his|her|its|one|each|every|any|no)\s+(?:\w+\s+){0,2}`;

/**
 * Whether `text` uses `@<slug>` in narrated position — the mention token named
 * as a noun ("the @admin mention", "a mention of @admin") rather than used to
 * address anyone. Both orders are recognised: a determiner-anchored token before
 * the noun, and the noun before an `of`/`from`/`by` token. The passive `@@slug`
 * is excluded (it fires nothing, so there is nothing to warn about).
 */
function isNarratedMentionPosition(text: string, slug: string): boolean {
	const s = escapeRegExp(slug);
	// The determiner's trailing `\s+` already guarantees no `@` precedes the token,
	// so `the @@admin mention` never matches.
	const trailing = new RegExp(
		String.raw`${NARRATED_DETERMINER_RE_SRC}@${s}(?![\w-])\s+${MENTION_NOUN_RE_SRC}\b`,
		'i',
	);
	// `\s+` before the token can't consume an `@`, so `mention of @@slug` never matches.
	const leading = new RegExp(
		String.raw`\b${MENTION_NOUN_RE_SRC}\s+(?:of|from|by)\s+@${s}(?![\w-])`,
		'i',
	);
	return trailing.test(text) || leading.test(text);
}

/**
 * Flags teammate slugs written as an ACTIVE `@<slug>` while merely *describing a
 * mention that lives somewhere else* — "the report contained the @admin mention
 * in TASK-7#comment-9". The reference reads as a pointer to the other comment,
 * but the renderer and the wakeup fan-out see an ordinary active mention, so it
 * fires a real wake (and, for `@admin`, an inbox row) on **this** comment. The
 * fix is backticks, not the passive form: `@@admin` renders as the bare word
 * `admin` and loses the very token being quoted, whereas `` `@admin` `` keeps
 * the literal text and notifies no one.
 *
 * The `@admin` case is self-defeating as well as noisy: a narrated `@admin`
 * lands a fresh unanswered admin ask, and an unanswered admin ask is exactly
 * what blocks the task from going `done` — so an agent explaining that it is
 * stuck behind an old `@admin` question deepens the block by writing about it.
 */
export function detectNarratedActiveMentions(content: unknown, knownSlugs: string[]): string[] {
	const text = flattenTextFields(content);
	if (!text) return [];
	const stripped = text.replace(FENCED_CODE_RE, ' ').replace(INLINE_CODE_RE, ' ');
	const flagged = new Set<string>();
	for (const rawSlug of knownSlugs) {
		const slug = rawSlug.toLowerCase();
		if (isNarratedMentionPosition(stripped, slug)) flagged.add(slug);
	}
	return Array.from(flagged);
}

/**
 * Slugs whose mention token is BOTH wrapped in inline code AND sitting in
 * narrated position (`` the `@architect` ping in TASK-4 ``) — the deliberate
 * quoted form detectNarratedActiveMentions asks authors to write. The
 * backticked-entity warning subtracts these from its candidates so the two
 * checks never contradict each other, telling the author to un-backtick a token
 * the sibling check just told them to backtick. Backticks are dropped rather
 * than the spans erased, so a quoted token is matched exactly as its bare form
 * would be.
 */
export function detectQuotedMentionTokens(content: unknown, knownSlugs: string[]): string[] {
	const text = flattenTextFields(content);
	if (!text) return [];
	const deTicked = text.replace(FENCED_CODE_RE, ' ').replace(/`([^`]+)`/g, '$1');
	const flagged = new Set<string>();
	for (const rawSlug of knownSlugs) {
		const slug = rawSlug.toLowerCase();
		if (isNarratedMentionPosition(deTicked, slug)) flagged.add(slug);
	}
	return Array.from(flagged);
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
 * Flags teammate slugs addressed with the PASSIVE mention form (`@@slug`) where an
 * active `@slug` was almost certainly intended — `@@` links without notifying, so
 * the handoff stalls silently. Four forms, gated differently:
 *
 * - An **action-assignment line** (`## Required actions for @@slug`) — the phrase
 *   on the line assigns the work, so it is its own ask signal.
 * - A **leading-line address** (`@@slug — …`, optionally after a routing label) is
 *   flagged unconditionally. Opening a line with a teammate reference and a
 *   separator is the address shape, reserved for active mentions; a genuine
 *   passive reference goes inside the sentence. `@@admin — release is done.` is
 *   the canonical miss — it is asking the admin to register the fact, but carries
 *   no pronoun, no `please` and no `?`, so no ask gate can see it.
 * - A **name bound directly to a sign-off/approval gate** (`Ready for @@slug
 *   review`, `awaiting @@slug sign-off`, `@@slug to approve`) — the mid-sentence
 *   handoff every address-position form above misses, because the name sits inside
 *   the sentence rather than opening a line. This is the verdict-report closing
 *   line (`APPROVED — the fix is correct. Ready for @@marketing-lead review.`):
 *   the one sentence whose whole job is to hand over the next action, marked with
 *   the form that wakes nobody. Same self-gating binding the bare-name detector
 *   uses (see hasNameBoundSignoffGate), so both spellings of the identical
 *   stranded handoff warn alike.
 * - **Any position, when the token's own SENTENCE reads as a directed ask** (see
 *   readsAsAsk) and does not merely cite the teammate (see isPurelyReferential).
 *   This is the general case and the reason the three shapes above are now a
 *   fast path rather than the whole check: they enumerate *positions*, which are
 *   an unbounded set, so each incident used to add one. It subsumes the former
 *   emphasised-`**@@slug**` branch, at a tighter scope — that branch gated on the
 *   whole paragraph, so a `you` in an unrelated sentence could pull an
 *   attribution into an ask.
 *
 * A slug also reached by an active `@`-mention is skipped — it already notifies —
 * EXCEPT on the leading-line branch, which asks a different question (see below).
 * Mirrors detectUnlinkedTeammateReferences for the passive form.
 */
export function detectPassiveTeammateAsks(content: unknown, knownSlugs: string[]): string[] {
	const text = flattenTextFields(content);
	if (!text) return [];
	const stripped = text.replace(FENCED_CODE_RE, ' ').replace(INLINE_CODE_RE, ' ');

	// A slug reached by an active @mention already notifies, so it never warns —
	// on the branches whose question IS "was anyone notified".
	const active = new Set(extractMentionSlugs(stripped));

	const flagged = new Set<string>();
	for (const rawSlug of knownSlugs) {
		const slug = rawSlug.toLowerCase();
		// An active @mention that is ITSELF an address exempts every branch: the
		// handoff is both delivered and correctly marked, so the passive spelling
		// elsewhere is the reference it looks like.
		if (hasActiveAddressingMention(stripped, slug)) continue;
		const s = escapeRegExp(slug);
		// Leading-line address (`@@slug — …`, optionally after a routing label): the
		// line-opening name-then-separator shape IS the address form, and the only
		// reason to write it is to hand the named teammate the next action — so the
		// passive marking is wrong on sight, with no ask gate. There is no legitimate
		// passive use of it: a reference you merely mean to *make* belongs inside the
		// sentence (`as @@slug noted, …`), not opening a line. This is the shape that
		// strands the most work, because the status vocabulary it attracts
		// (`@@admin — release is done.`) is exactly what the ask gate cannot see.
		//
		// Checked ABOVE the `active` exemption, and it is the only branch that is:
		// this branch does not ask "was anyone notified", it asks "is the address
		// marked correctly", and a mention that notifies from somewhere else in the
		// comment does not answer that. `@@admin — <directive>` plus a throwaway
		// `… the earlier @admin ZIP request …` two sentences later is the miss —
		// the ask wears the muted mark and a back-reference wears the live one, so
		// every net stood down while the reader's eye landed on the wrong chip.
		if (leadingAddressRegex(`@@${s}`).test(stripped)) {
			flagged.add(slug);
			continue;
		}
		if (active.has(slug)) continue;
		// Action-assignment line: `## Required actions for @@slug` — the phrase on
		// the line is itself the ask signal, no paragraph gate needed. The trailing
		// guard keeps a slug from matching inside a longer hyphenated slug
		// (`@@qa` in `@@qa-engineer`).
		if (hasActionAssignmentLine(stripped, String.raw`(?<![\w@])@@${s}(?![\w-])`)) {
			flagged.add(slug);
			continue;
		}
		// Name-bound sign-off gate with the passive form: `Ready for @@slug review`,
		// `awaiting @@slug sign-off`, `@@slug to approve`. The binding to the gate is
		// itself the ask signal, so like the action-assignment line it needs no
		// readsAsAsk pass. Without this branch a closing verdict line that hands the
		// next action to a named approver mid-sentence — the shape a review report
		// ends on — matched none of the address-position forms and warned nowhere,
		// even though the bare-name spelling of the same sentence already did.
		if (hasNameBoundSignoffGate(stripped, String.raw`(?<![\w@])@@${s}(?![\w-])`)) {
			flagged.add(slug);
			continue;
		}
		// POSITION-INDEPENDENT ask gate — the branch that keeps this detector off the
		// treadmill. Any `@@slug` whose OWN SENTENCE reads as a directed ask is
		// flagged wherever the token sits, so a new phrasing never needs a new
		// positional branch (see the four above, each added by an incident).
		//
		// Safe for the passive form specifically because `@@slug` is deliberate
		// internal mention syntax naming exactly one teammate: there is no "the word
		// happened to appear" failure mode, so position adds nothing beyond what the
		// token already proves. A BARE name has that failure mode, which is why
		// detectUnlinkedTeammateAsks still requires an address position.
		//
		// Sentence scope (not the paragraph scope the bold branch used) is what makes
		// it safe: a `you` three sentences away can no longer pull an unrelated
		// attribution into an ask. A sentence that only CITES the teammate is vetoed
		// by isPurelyReferential, so `as @@architect noted, you should keep the
		// interface stable` credits without warning.
		//
		// The miss this was written for: `… cleared for admin presentation.
		// @@equity-analyst — please mark INV-86 done.` — mid-paragraph, mid-line, not
		// bold, no sign-off vocabulary, so every positional branch above declined it
		// while the strongest ask signal in the vocabulary sat four characters away.
		const namePattern = String.raw`(?<![\w@])@@${s}(?![\w-])`;
		if (
			sentencesContaining(stripped, namePattern).some(
				(sentence) => readsAsAsk(sentence) && !isPurelyReferential(sentence, namePattern),
			)
		) {
			flagged.add(slug);
		}
	}
	return Array.from(flagged);
}

/**
 * Flags teammate slugs addressed with the UNLINKED form — bold (`**slug**` /
 * `__slug__`), a leading-line address (`slug —` / `slug:`), or a name bound
 * directly to a sign-off/approval gate (`awaiting slug sign-off`, `slug to
 * approve`), no `@` prefix at all — where the surrounding text reads like an ask,
 * so an active `@slug` was almost certainly intended yet the bare/bold name
 * renders as inert text and wakes no one, stranding the handoff silently. The
 * bold/leading forms add the same directed-ask gate detectPassiveTeammateAsks
 * uses (see readsAsAsk) so a name written for mere emphasis or attribution is
 * never flagged; the action-assignment line and the name-bound sign-off gate are
 * self-gating (the binding IS the ask). A slug also reached by an active
 * `@`-mention anywhere is skipped — it already notifies — except on the
 * leading-line branch, which asks whether the address is marked correctly rather
 * than whether anyone was notified (see detectPassiveTeammateAsks). The runner's
 * handoff-delivery net uses these to warn (in the run log) that a run ended with a
 * stranded bare-name handoff, mirroring create_comment's interactive warning.
 */
export function detectUnlinkedTeammateAsks(content: unknown, knownSlugs: string[]): string[] {
	const text = flattenTextFields(content);
	if (!text) return [];
	const stripped = text.replace(FENCED_CODE_RE, ' ').replace(INLINE_CODE_RE, ' ');

	// A slug reached by an active @mention already notifies, so it never warns —
	// on the branches whose question IS "was anyone notified".
	const active = new Set(extractMentionSlugs(stripped));

	const flagged = new Set<string>();
	for (const rawSlug of knownSlugs) {
		const slug = rawSlug.toLowerCase();
		// An active @mention that is ITSELF an address exempts every branch.
		if (hasActiveAddressingMention(stripped, slug)) continue;
		const s = escapeRegExp(slug);
		const activeElsewhere = active.has(slug);
		if (!activeElsewhere) {
			// Action-assignment line with the bare name: `## Required actions for slug`
			// — the phrase on the line is itself the ask signal, no paragraph gate
			// needed. The lookbehind keeps `@slug`/`@@slug` out (handled elsewhere) and,
			// with the trailing guard, keeps a slug from matching inside a longer
			// hyphenated slug (`engineer` in `qa-engineer` / `engineer-lead`).
			if (hasActionAssignmentLine(stripped, String.raw`(?<![\w@-])${s}(?![\w-])`)) {
				flagged.add(slug);
				continue;
			}
			// Name-bound sign-off gate: a mid-sentence handoff the address-position
			// forms miss because the name sits inside the sentence rather than opening a
			// line — `awaiting slug sign-off`, `needs slug's approval`, `slug to sign
			// off`. The binding of the name to the sign-off gate is itself the ask
			// signal, so like the action-assignment line it needs no readsAsAsk pass.
			if (hasNameBoundSignoffGate(stripped, String.raw`(?<![\w@-])${s}(?![\w-])`)) {
				flagged.add(slug);
				continue;
			}
		}
		// Emphasised name (**slug**/__slug__, not already @-prefixed) or a
		// leading-line address (`slug —`/`slug:`, optionally after a routing label)
		// — mirrors the addressing forms detectUnlinkedTeammateReferences recognises.
		// The leading-line form survives an active mention elsewhere (it asks whether
		// the address is marked, not whether anyone was notified); the bold form does
		// not, since bold marks emphasis and attribution as readily as an address.
		const bold = new RegExp(String.raw`(?<!@)(\*\*|__)${s}\1`, 'i');
		const lead = leadingAddressRegex(s);
		if (!lead.test(stripped) && (activeElsewhere || !bold.test(stripped))) continue;
		// Only warn when the paragraph(s) carrying this address read as an ask —
		// scoped to those paragraphs so a `you` elsewhere never leaks in.
		const block = unlinkedMentionParagraphs(stripped, s);
		if (block && readsAsAsk(block)) flagged.add(slug);
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

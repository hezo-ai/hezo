import { INJECTED_TEXT_CAPS } from '@hezo/shared';
import { excerpt } from '../mcp/paging';

/**
 * How much task-scoped text a run prompt may carry inline.
 *
 * The prompt's fixed half - shared instructions, the role prompt, the project
 * blocks - is bounded elsewhere and by its own ceilings. This bounds the half
 * that grows with a task: the thread, the description, the handoff quote.
 *
 * Two mechanisms, and the distinction is the whole design. **The ceilings are
 * what shapes a normal prompt**; each section gets a width chosen for what that
 * section is for, and on almost every run the total never comes near this
 * number. **The budget exists only so N sections cannot sum past it.** Capping
 * each section individually leaves the total an arithmetic coincidence that
 * reopens the moment a section is added - which is how this hole was opened
 * twice, once by the comment block and once by the description block.
 *
 * The number is the sum of the ceilings below (51,000), less the sections that
 * cannot fire together: a run is woken by a reply or by a mention, never both.
 * Deliberately well under what any runtime would accept, for the reason
 * `INJECTED_TEXT_CAPS` gives - instruction-following degrades with the number of
 * stacked rules long before a context window fills, so a generous cap buys
 * nothing except a prompt nobody reads to the end.
 *
 * This bounds the **source text** a section contributes. Rendering adds its own
 * markup - section headers, and a `> ` on each line of a quoted comment - which
 * is proportional and small next to the headroom the assembled prompt keeps
 * against the tightest runtime ceiling. `RUNTIME_PROMPT_MAX_CHARS` measures what
 * is actually delivered, so nothing rests on that overhead being zero.
 */
export const PROMPT_BUDGET_CHARS = 48_000;

/**
 * Per-section widths, each derived from what the section is read for rather than
 * from what would fit.
 *
 * A comment quoted because it woke the run is an instruction and gets room to
 * state one; a comment carried as a head-start is triage and gets the width the
 * tool surface already chose for triage (`DEFAULT_COMMENT_EXCERPT_CHARS`).
 */
export const PROMPT_SECTION_CEILINGS = {
	/** The comment that woke this run, quoted in its handoff. It is the ask. */
	wakingComment: 12_000,
	/** On a reply wake, the agent's own earlier comment being replied to. */
	replyOriginal: 6_000,
	/**
	 * A title is a line, and every surface treats it as one - but nothing refuses
	 * a long one at write time, and it is rendered raw into a heading. Wide enough
	 * that no real title is touched, narrow enough that it cannot be a section.
	 */
	taskTitle: 500,
	/** The task definition, read as instruction. */
	taskDescription: 12_000,
	taskRules: 6_000,
	/**
	 * The write-time ceiling, read rather than restated. A progress summary is
	 * already refused above this size, so a second number here would be a second
	 * mechanism on one field - and the one that could silently disagree.
	 */
	taskProgressSummary: INJECTED_TEXT_CAPS.task_progress_summary,
	/** One row of the head-start thread block. */
	recentComment: 2_000,
	/** One row of the Coach's review window. */
	reviewComment: 2_000,
} as const;

export type PromptSection = keyof typeof PROMPT_SECTION_CEILINGS;

/** What a section actually got, and what it would have taken whole. */
export interface BudgetedText {
	text: string;
	truncated: boolean;
	/** The full length of the source, whether or not it was cut. */
	length: number;
}

/**
 * A single run's remaining allowance, spent in priority order.
 *
 * Spend-as-you-go rather than reserve-then-redistribute: a section takes the
 * lesser of its own ceiling and what is left, so the total is bounded by
 * construction in one pass, and a short section leaves its slack for the next
 * one without anything having to hand it over. Order is therefore the priority
 * list - the caller renders the instruction-bearing sections first.
 */
export class PromptBudget {
	private remaining: number;

	constructor(total: number = PROMPT_BUDGET_CHARS) {
		this.remaining = total;
	}

	/** What is still unspent. Exposed for the invariant test, not for branching. */
	get left(): number {
		return this.remaining;
	}

	/**
	 * Take a section's text, cut to the lesser of its ceiling and the remainder.
	 *
	 * Returns the full `length` even when nothing was cut, because the caller
	 * renders it either way: a reader who is told a body's real size can decide
	 * not to fetch the rest, and one who is told only "there is more" cannot.
	 */
	take(section: PromptSection, text: string | null | undefined): BudgetedText {
		const allowed = Math.min(PROMPT_SECTION_CEILINGS[section], this.remaining);
		const cut = excerpt(text, Math.max(0, allowed));
		const out = cut.excerpt ?? '';
		this.remaining = Math.max(0, this.remaining - out.length);
		return { text: out, truncated: cut.truncated, length: cut.length };
	}
}

/**
 * The line that follows a cut section, naming what was dropped and the exact
 * call that serves the rest.
 *
 * Both halves are load-bearing. Without the call the cut is a dead end; without
 * the length the agent cannot tell a body worth paging from one worth skipping,
 * and pages a megabyte at a window a time. This is the same contract
 * `list_comments` states with `text_truncated`/`text_length`/`text_paging_hint`,
 * which is what keeps a bounded prompt a size hint rather than a silent
 * alternative.
 */
export function overflowNote(shown: number, total: number, recoveryCall: string): string {
	return `_[showing the first ${shown} of ${total} characters - read the rest with \`${recoveryCall}\`]_`;
}

/**
 * The overflow line for a list whose rows were dropped, rather than cut.
 */
export function omittedRowsNote(shown: number, total: number, recoveryCall: string): string {
	return `_[showing the most recent ${shown} of ${total} - read the rest with \`${recoveryCall}\`]_`;
}

/**
 * A budgeted section's lines: its text, and the overflow line when it was cut.
 *
 * `fallback` is what an empty section renders as, so a caller need not decide
 * separately whether the text was empty before budgeting or emptied by it.
 */
export function budgetedSection(
	cut: BudgetedText,
	recoveryCall: string,
	fallback: string[] = [],
): string[] {
	// Empty source and squeezed-to-nothing are different facts and must not render
	// the same. `fallback` says the field is unset; a section the budget had no room
	// left for still exists, and saying "none provided" about it would be a lie the
	// agent acts on.
	if (cut.length === 0) return fallback;
	if (!cut.truncated) return [cut.text];
	const note = overflowNote(cut.text.length, cut.length, recoveryCall);
	return cut.text.length === 0 ? [note] : [cut.text, note];
}

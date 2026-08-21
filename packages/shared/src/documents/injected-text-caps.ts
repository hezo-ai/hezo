/**
 * Size ceilings for the agent-written text that is injected into a prompt in full.
 *
 * The rule these encode: **cap what an agent writes and nothing else bounds.** A
 * task description or set of rules is written by a human and bounded by their
 * effort, and refusing that write is hostile; those are excerpted on read instead.
 * These surfaces are different — an agent writes them, they land verbatim in a
 * prompt on every run or every turn, and nothing removes anything, so they only
 * grow.
 *
 * Why a refusal rather than truncation: silently dropping the tail of an
 * instruction block changes what an agent is told without anyone knowing. A
 * refusal that names the ceiling makes the next write a compaction.
 *
 * One thing a ceiling must never do is freeze what is already past it. Setting a
 * team up writes these fields uncapped (a roster must not fail to install because
 * a role was authored long), so a value can legitimately start over the line, and
 * a rule that only asked "does the new value fit" would refuse every edit that
 * shrinks it - including the consolidation being asked for. Pass the current
 * length and an over-ceiling value stays editable **downwards**: shorter than it
 * is now is always accepted, longer never is, and the plain rule resumes the
 * moment it is back under.
 *
 * The numbers are deliberately well under "whatever fits". Instruction-following
 * degrades with the number of stacked behavioural rules long before a context
 * window fills, so a generous cap buys nothing except a prompt nobody reads to the
 * end.
 */
export const INJECTED_TEXT_CAPS = {
	/** Injected into every agent's system prompt in the project, on every run. */
	team_preferences: 12_000,
	/** One agent's own prompt, including the Learned Rules the Coach appends. */
	agent_system_prompt: 40_000,
	/** Injected into every turn of the operator chat; rewritten by compaction. */
	chat_memory: 12_000,
	/** Injected into the run prompt of the task it belongs to. */
	task_progress_summary: 8_000,
	/** The "## Your Team" block on one agent's prompt. */
	agent_team_context: 6_000,
} as const;

export type InjectedTextKind = keyof typeof INJECTED_TEXT_CAPS;

/** Human-readable name per kind, so a refusal says what it is talking about. */
const LABELS: Record<InjectedTextKind, string> = {
	team_preferences: 'Custom Prompt',
	agent_system_prompt: 'system prompt',
	chat_memory: 'long-term chat memory',
	task_progress_summary: 'progress summary',
	agent_team_context: 'team context',
};

export interface InjectedTextTooLarge {
	kind: InjectedTextKind;
	limit: number;
	length: number;
	error: string;
}

/**
 * `null` when `content` may be written, otherwise a refusal describing the overage.
 *
 * The message carries the ceiling and the actual size on purpose: the caller is
 * usually an agent, and a refusal it cannot act on is a loop. Knowing both numbers
 * turns the retry into a compaction rather than a guess.
 *
 * `currentLength` is the length of the value being replaced. Supply it wherever
 * the caller already knows it: without it a value that starts over the ceiling can
 * only be fixed by one all-at-once rewrite, which is the read-whole/rewrite-whole
 * loop the span-edit tools exist to avoid, forced at the worst moment. With it the
 * same value can be walked down one edit at a time.
 */
export function checkInjectedTextCap(
	kind: InjectedTextKind,
	content: string,
	currentLength?: number,
): InjectedTextTooLarge | null {
	const limit = INJECTED_TEXT_CAPS[kind];
	const length = content.length;
	if (length <= limit) return null;

	// Already past the ceiling: accept anything strictly shorter, so consolidating
	// works span by span. Not `<=` - an edit that leaves it the same size makes no
	// progress, and the pressure to get back under is the whole point.
	const alreadyOver = currentLength !== undefined && currentLength > limit;
	if (alreadyOver && length < currentLength) return null;

	const preamble = `This ${LABELS[kind]} is ${length} characters, over the ${limit}-character limit by ${length - limit}. `;
	if (alreadyOver) {
		return {
			kind,
			limit,
			length,
			error:
				preamble +
				`It was already over the limit at ${currentLength} characters before this write, so it can ` +
				'still be edited, but only downwards: send something shorter than it is now, as many times ' +
				'as it takes. This one is not shorter.',
		};
	}
	return {
		kind,
		limit,
		length,
		error:
			preamble +
			'It is injected in full into a prompt, so it has a ceiling. Consolidate it: merge overlapping ' +
			'entries, drop guidance that no longer applies, and keep each point to a line. Re-send the ' +
			'shortened version.',
	};
}

/**
 * Thrown by a write path that has no structured error channel of its own. Routes
 * and tools catch it and turn it into a 400 / `{ error }` carrying the message.
 */
export class InjectedTextCapError extends Error {
	readonly code = 'INJECTED_TEXT_TOO_LARGE';
	constructor(message: string) {
		super(message);
		this.name = 'InjectedTextCapError';
	}
}

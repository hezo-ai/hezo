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
 * `null` when `content` fits, otherwise a refusal describing the overage.
 *
 * The message carries the ceiling and the actual size on purpose: the caller is
 * usually an agent, and a refusal it cannot act on is a loop. Knowing both numbers
 * turns the retry into a compaction rather than a guess.
 */
export function checkInjectedTextCap(
	kind: InjectedTextKind,
	content: string,
): InjectedTextTooLarge | null {
	const limit = INJECTED_TEXT_CAPS[kind];
	const length = content.length;
	if (length <= limit) return null;
	return {
		kind,
		limit,
		length,
		error:
			`This ${LABELS[kind]} is ${length} characters, over the ${limit}-character limit by ${length - limit}. ` +
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

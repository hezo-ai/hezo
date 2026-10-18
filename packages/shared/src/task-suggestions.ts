/**
 * The CEO's task suggestions: one-click cards that become real tasks on
 * approval. What a suggestion is (its kind), whether it may repeat, and what an
 * approved repeating one tells the agent that works it - one table each, read by
 * the suggestion tool, the cadence edit route and the card alike.
 */

/** What a suggested task is for. The card shows it; the cadence rule keys on it. */
export const TaskSuggestionKind = {
	/** Information only the admin can give (the stocks to watch). */
	AdminInput: 'admin_input',
	/** A service the team reads or acts on (an online broker). */
	Connection: 'connection',
	/** Work that comes back on a schedule (a news catch-up). */
	Recurring: 'recurring',
	/** A report, periodic or not. */
	Report: 'report',
	/** The first concrete output the brief asks for. */
	Deliverable: 'deliverable',
} as const;
export type TaskSuggestionKind = (typeof TaskSuggestionKind)[keyof typeof TaskSuggestionKind];

/**
 * How often an approved suggestion runs. The CEO proposes daily, weekly or
 * monthly; `once` exists only as the admin's choice on a card that repeats.
 */
export const TaskSuggestionCadence = {
	Daily: 'daily',
	Weekly: 'weekly',
	Monthly: 'monthly',
	Once: 'once',
} as const;
export type TaskSuggestionCadence =
	(typeof TaskSuggestionCadence)[keyof typeof TaskSuggestionCadence];

/** A cadence that repeats: the ones the CEO may propose. */
export type RepeatingCadence = Exclude<TaskSuggestionCadence, 'once'>;

/** Most cards the CEO files on one suggestions task. */
export const MAX_TASK_SUGGESTIONS_PER_TASK = 8;

type CadenceRule = 'forbidden' | 'required' | 'optional';

/**
 * Whether each kind may repeat. Setup, a connection and a first deliverable are
 * done once, so they carry no cadence and their card shows no repeat choice.
 */
export const TASK_SUGGESTION_KIND_RULES: Record<TaskSuggestionKind, { cadence: CadenceRule }> = {
	admin_input: { cadence: 'forbidden' },
	connection: { cadence: 'forbidden' },
	recurring: { cadence: 'required' },
	report: { cadence: 'optional' },
	deliverable: { cadence: 'forbidden' },
};

/**
 * The `rules` an approved repeating suggestion's task carries, in the
 * standing-task form the shared agent guidance describes.
 */
export const TASK_SUGGESTION_CADENCE_RULES: Record<RepeatingCadence, string> = {
	daily:
		'Repeats daily. This is a standing task: do one round each day as a child task, and never mark this task done.',
	weekly:
		'Repeats weekly. This is a standing task: do one round each week as a child task, and never mark this task done.',
	monthly:
		'Repeats monthly. This is a standing task: do one round each month as a child task, and never mark this task done.',
};

const REPEATING: readonly string[] = ['daily', 'weekly', 'monthly'];
const ALL_CADENCES: readonly string[] = Object.values(TaskSuggestionCadence);

export function isTaskSuggestionKind(value: unknown): value is TaskSuggestionKind {
	return (
		typeof value === 'string' && (Object.values(TaskSuggestionKind) as string[]).includes(value)
	);
}

export function isTaskSuggestionCadence(value: unknown): value is TaskSuggestionCadence {
	return typeof value === 'string' && ALL_CADENCES.includes(value);
}

export function isRepeatingCadence(value: unknown): value is RepeatingCadence {
	return typeof value === 'string' && REPEATING.includes(value);
}

/**
 * Check the cadence the CEO proposes for a kind. Returns an error naming the
 * rule, or null when the pair is allowed.
 */
export function validateSuggestedCadence(
	kind: TaskSuggestionKind,
	cadence: string | null | undefined,
): string | null {
	const rule = TASK_SUGGESTION_KIND_RULES[kind].cadence;
	if (cadence === null || cadence === undefined) {
		return rule === 'required'
			? `A ${kind} suggestion needs a cadence: daily, weekly or monthly.`
			: null;
	}
	if (!isRepeatingCadence(cadence)) {
		return 'cadence must be daily, weekly or monthly. Leave it out for work that does not repeat.';
	}
	if (rule === 'forbidden') {
		return `A ${kind} suggestion does not repeat, so it takes no cadence.`;
	}
	return null;
}

/**
 * Check the admin's choice on a card. Only a suggestion the CEO gave a cadence
 * offers the choice, and then any of daily, weekly, monthly or once is allowed.
 */
export function validateCadenceChoice(
	suggestedCadence: string | null | undefined,
	choice: unknown,
): string | null {
	if (!isRepeatingCadence(suggestedCadence)) {
		return 'This suggestion does not repeat, so its cadence cannot be set.';
	}
	if (!isTaskSuggestionCadence(choice)) {
		return 'cadence must be daily, weekly, monthly or once.';
	}
	return null;
}

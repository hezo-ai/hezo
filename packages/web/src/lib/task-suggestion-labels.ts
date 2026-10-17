import type { TaskSuggestionCadence, TaskSuggestionKind } from '@hezo/shared';
import type { MessageKey } from './i18n';

/** The catalog key naming each suggestion kind on a card. */
export const TASK_SUGGESTION_KIND_LABEL: Record<TaskSuggestionKind, MessageKey> = {
	admin_input: 'taskSuggestion.kind.adminInput',
	connection: 'taskSuggestion.kind.connection',
	recurring: 'taskSuggestion.kind.recurring',
	report: 'taskSuggestion.kind.report',
	deliverable: 'taskSuggestion.kind.deliverable',
};

/** The catalog key for each repeat choice on a card. */
export const TASK_SUGGESTION_CADENCE_LABEL: Record<TaskSuggestionCadence, MessageKey> = {
	daily: 'taskSuggestion.cadence.daily',
	weekly: 'taskSuggestion.cadence.weekly',
	monthly: 'taskSuggestion.cadence.monthly',
	once: 'taskSuggestion.cadence.once',
};

/** The catalog key saying how often a decided suggestion runs. */
export const TASK_SUGGESTION_REPEATS_NOTE: Record<TaskSuggestionCadence, MessageKey> = {
	daily: 'taskSuggestion.repeatsNote.daily',
	weekly: 'taskSuggestion.repeatsNote.weekly',
	monthly: 'taskSuggestion.repeatsNote.monthly',
	once: 'taskSuggestion.repeatsNote.once',
};

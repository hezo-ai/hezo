import { TASK_VIEWS, type TaskView } from '@hezo/shared';
import { MessageSquare, Rows3 } from 'lucide-react';
import type { SegmentedOption } from '../components/ui/segmented-control';
import { type MessageKey, useI18n } from './i18n';

/**
 * How each view presents itself, wherever it is offered. A table rather than a
 * branch: adding a view to `TASK_VIEWS` becomes a compile error here until it
 * has a label and an icon, and every surface picks both up at once.
 */
export const TASK_VIEW_META: Record<
	TaskView,
	{ labelKey: MessageKey; icon: React.ComponentType<{ className?: string }> }
> = {
	conversation: { labelKey: 'taskView.conversation', icon: MessageSquare },
	detailed: { labelKey: 'taskView.detailed', icon: Rows3 },
};

/** Both views as segmented-control options, labelled in the instance language. */
export function useTaskViewOptions(): SegmentedOption<TaskView>[] {
	const { t } = useI18n();
	return TASK_VIEWS.map((value) => ({
		value,
		label: t(TASK_VIEW_META[value].labelKey),
		icon: TASK_VIEW_META[value].icon,
	}));
}

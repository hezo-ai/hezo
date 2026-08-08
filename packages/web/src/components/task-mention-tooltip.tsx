import { TaskStatusBadge } from './task-status-badge';

/**
 * Tooltip body for a task reference: `<IDENTIFIER>: <title>` over an optional
 * status pill. Shared by the markdown @mention link renderer and the task
 * list's truncated titles, so both surfaces show the same card.
 */
export function TaskMentionTooltipContent({
	identifier,
	title,
	status,
}: {
	identifier: string;
	title: string;
	status?: string;
}) {
	return (
		<span className="flex flex-col gap-1">
			<span>
				<strong>{identifier.toUpperCase()}:</strong> {title}
			</span>
			{status ? (
				<TaskStatusBadge status={status} className="self-start" testId="task-mention-status-pill" />
			) : null}
		</span>
	);
}

import { formatTaskStatus, TaskStatus } from '@hezo/shared';
import { Badge } from './ui/badge';

type BadgeColor = 'neutral' | 'warning' | 'purple' | 'danger' | 'success';

const STATUS_COLORS: Record<TaskStatus, BadgeColor> = {
	[TaskStatus.Backlog]: 'neutral',
	[TaskStatus.InProgress]: 'warning',
	[TaskStatus.Review]: 'purple',
	[TaskStatus.Blocked]: 'danger',
	[TaskStatus.Done]: 'success',
	[TaskStatus.Closed]: 'neutral',
	[TaskStatus.Cancelled]: 'neutral',
};

export function TaskStatusBadge({ status, className }: { status: string; className?: string }) {
	const color = STATUS_COLORS[status as TaskStatus] ?? 'neutral';
	return (
		<Badge color={color} className={className}>
			{formatTaskStatus(status)}
		</Badge>
	);
}

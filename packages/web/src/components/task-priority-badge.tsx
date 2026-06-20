import { taskPriorityColor } from '../lib/status-meta';
import { Badge } from './ui/badge';

export function TaskPriorityBadge({
	priority,
	className,
	testId,
}: {
	priority: string;
	className?: string;
	testId?: string;
}) {
	return (
		<Badge color={taskPriorityColor(priority)} className={className} testId={testId}>
			{priority}
		</Badge>
	);
}

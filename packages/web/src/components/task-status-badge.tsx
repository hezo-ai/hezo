import { formatTaskStatus } from '@hezo/shared';
import { taskStatusColor } from '../lib/status-meta';
import { Badge } from './ui/badge';

export function TaskStatusBadge({
	status,
	className,
	testId,
}: {
	status: string;
	className?: string;
	testId?: string;
}) {
	return (
		<Badge color={taskStatusColor(status)} className={className} testId={testId}>
			{formatTaskStatus(status)}
		</Badge>
	);
}

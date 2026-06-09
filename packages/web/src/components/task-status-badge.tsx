import { formatTaskStatus } from '@hezo/shared';
import { taskStatusColor } from '../lib/status-meta';
import { Badge } from './ui/badge';

export function TaskStatusBadge({ status, className }: { status: string; className?: string }) {
	return (
		<Badge color={taskStatusColor(status)} className={className}>
			{formatTaskStatus(status)}
		</Badge>
	);
}

import { formatProjectStatus, type ProjectStatus } from '@hezo/shared';
import { Badge } from './ui/badge';

const projectStatusColors: Record<ProjectStatus, 'green' | 'danger' | 'warning' | 'neutral'> = {
	completed: 'green',
	error: 'danger',
	working: 'warning',
	idle: 'neutral',
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
	return (
		<span data-testid={`project-status-${status}`} className="shrink-0">
			<Badge color={projectStatusColors[status]}>
				{status === 'working' && (
					<span
						className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse mr-1"
						aria-hidden="true"
					/>
				)}
				{formatProjectStatus(status)}
			</Badge>
		</span>
	);
}

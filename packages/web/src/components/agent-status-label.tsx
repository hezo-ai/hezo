import { agentRuntimeStatusMeta } from '../lib/status-meta';
import { Badge } from './ui/badge';

interface AgentStatusLabelProps {
	name: string;
	runtimeStatus: string;
	className?: string;
}

export function AgentStatusLabel({ name, runtimeStatus, className = '' }: AgentStatusLabelProps) {
	const badge = agentRuntimeStatusMeta(runtimeStatus);
	return (
		<span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
			<span className="min-w-0 truncate">{name}</span>
			<Badge color={badge.color} className="shrink-0">
				{badge.label}
			</Badge>
		</span>
	);
}

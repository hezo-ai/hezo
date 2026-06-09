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
		<span className={`inline-flex items-center gap-1.5 ${className}`}>
			<span className="truncate">{name}</span>
			<Badge color={badge.color}>{badge.label}</Badge>
		</span>
	);
}

import { AgentRuntimeStatus } from '@hezo/shared';
import { Badge } from './ui/badge';

export const RUNTIME_BADGE: Record<string, { color: string; label: string }> = {
	[AgentRuntimeStatus.Active]: { color: 'green', label: 'Running' },
	[AgentRuntimeStatus.Paused]: { color: 'yellow', label: 'Paused' },
	[AgentRuntimeStatus.Idle]: { color: 'neutral', label: 'Idle' },
};

interface AgentStatusLabelProps {
	name: string;
	runtimeStatus: string;
	className?: string;
}

export function AgentStatusLabel({ name, runtimeStatus, className = '' }: AgentStatusLabelProps) {
	const badge = RUNTIME_BADGE[runtimeStatus] ?? RUNTIME_BADGE[AgentRuntimeStatus.Idle];
	return (
		<span className={`inline-flex items-center gap-1.5 ${className}`}>
			<span className="truncate">{name}</span>
			<Badge color={badge.color as 'neutral'}>{badge.label}</Badge>
		</span>
	);
}

import { AgentRuntimeStatus, BUDGET_PAUSE_STATUSES } from '@hezo/shared';
import { agentRuntimeStatusMeta } from '../lib/status-meta';
import { Badge } from './ui/badge';

interface AgentStatusLabelProps {
	name: string;
	runtimeStatus: string;
	/**
	 * `badge` (default) renders the quiet-tint pill used on the task rail, the
	 * agent roster and assignee menus. `sidebar` renders the design system's
	 * team-list row: the name on the left, the status right-aligned in lowercase
	 * mono, with a running agent shown in the cyan `live` tone and a bold name.
	 */
	variant?: 'badge' | 'sidebar';
	className?: string;
}

export function AgentStatusLabel({
	name,
	runtimeStatus,
	variant = 'badge',
	className = '',
}: AgentStatusLabelProps) {
	if (variant === 'sidebar') {
		const running = runtimeStatus === AgentRuntimeStatus.Active;
		const paused = (BUDGET_PAUSE_STATUSES as readonly string[]).includes(runtimeStatus);
		const statusColor = running ? 'text-live' : paused ? 'text-danger' : 'text-text-3';
		return (
			<span className={`flex min-w-0 flex-1 items-center justify-between gap-2 ${className}`}>
				<span className={`min-w-0 truncate ${running ? 'font-semibold text-text-1' : ''}`}>
					{name}
				</span>
				<span className={`shrink-0 font-mono text-[11px] ${statusColor}`}>
					{running ? 'running' : paused ? 'paused' : 'idle'}
				</span>
			</span>
		);
	}

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

import { AgentRuntimeStatus, BUDGET_PAUSE_STATUSES } from '@hezo/shared';
import { agentRuntimeStatusMeta } from '../lib/status-meta';
import { Badge } from './ui/badge';
import { StatusDot } from './ui/status-dot';

interface AgentStatusLabelProps {
	name: string;
	runtimeStatus: string;
	/**
	 * `badge` (default) renders the quiet-tint pill used on the task rail, the
	 * agent roster and assignee menus. `sidebar` renders the design system's
	 * team-list row: the name on the left and a right-aligned status dot — a
	 * pulsing cyan `live` dot (plus a bold name) while the agent is running, an
	 * amber dot when budget-paused, and nothing at all when idle.
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
		return (
			<span className={`flex min-w-0 flex-1 items-center justify-between gap-2 ${className}`}>
				<span className={`min-w-0 truncate ${running ? 'font-semibold text-text-1' : ''}`}>
					{name}
				</span>
				{running ? (
					<StatusDot status="active" pulse label="Running" />
				) : paused ? (
					<StatusDot status="paused" label="Over budget" />
				) : null}
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

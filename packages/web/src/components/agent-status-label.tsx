import { AgentRuntimeStatus, BUDGET_PAUSE_STATUSES } from '@hezo/shared';
import { agentRuntimeStatusMeta, type BadgeMeta } from '../lib/status-meta';
import { AgentRef, type AgentRefIdentity } from './agent-ref';
import { Badge } from './ui/badge';
import { StatusDot } from './ui/status-dot';

interface AgentStatusLabelProps {
	/**
	 * The label to show. Kept as a plain string because this component also
	 * renders the "-" unassigned placeholder, which has no agent behind it.
	 */
	name: string;
	/**
	 * The agent the label names, when the caller has it. Supplying it renders the
	 * name through {@link AgentRef}, so the row gains the identity hover card;
	 * without it the label stays exactly as before.
	 */
	agent?: AgentRefIdentity | null;
	runtimeStatus: string;
	/**
	 * `badge` (default) renders the quiet-tint pill used on the task rail, the
	 * agent roster and assignee menus. `sidebar` renders the design system's
	 * team-list row: the name on the left and a right-aligned status dot — a
	 * pulsing cyan `live` dot (plus a bold name) while the agent is running, an
	 * amber dot when budget-paused, and nothing at all when idle.
	 */
	variant?: 'badge' | 'sidebar';
	/**
	 * Overrides the badge derived from `runtimeStatus`, for callers whose pill
	 * describes something other than the agent's own runtime status — the task
	 * sidebar labels the *run* on the task ("Queued" vs "Running"). Ignored by the
	 * `sidebar` variant, which renders a dot rather than a pill.
	 */
	badge?: BadgeMeta;
	className?: string;
}

export function AgentStatusLabel({
	name,
	agent,
	runtimeStatus,
	variant = 'badge',
	badge: badgeOverride,
	className = '',
}: AgentStatusLabelProps) {
	// One spelling of the label for both variants: through `AgentRef` when the
	// caller knows which agent this is, a bare span otherwise. Never tap-to-open -
	// every caller renders this inside a link row or a menu button, and swallowing
	// the tap to show the card would swallow the navigation with it.
	const labelWith = (labelClassName: string) =>
		agent ? (
			<AgentRef agent={agent} fallbackName={name} className={labelClassName} tapToOpen={false} />
		) : (
			<span className={labelClassName}>{name}</span>
		);

	if (variant === 'sidebar') {
		const running = runtimeStatus === AgentRuntimeStatus.Active;
		const paused = (BUDGET_PAUSE_STATUSES as readonly string[]).includes(runtimeStatus);
		return (
			<span className={`flex min-w-0 flex-1 items-center justify-between gap-2 ${className}`}>
				{labelWith(`min-w-0 truncate ${running ? 'font-semibold text-text-1' : ''}`)}
				{running ? (
					<StatusDot status="active" pulse label="Running" />
				) : paused ? (
					<StatusDot status="paused" label="Over budget" />
				) : null}
			</span>
		);
	}

	const badge = badgeOverride ?? agentRuntimeStatusMeta(runtimeStatus);
	return (
		<span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
			{labelWith('min-w-0 truncate')}
			<Badge color={badge.color} className="shrink-0">
				{badge.label}
			</Badge>
		</span>
	);
}

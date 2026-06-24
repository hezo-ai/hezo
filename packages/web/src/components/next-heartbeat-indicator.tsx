import { Activity } from 'lucide-react';
import { useNextHeartbeatCountdown } from '../hooks/use-next-heartbeat';

/**
 * Live "Next heartbeat in …" countdown for an agent. Renders nothing when the
 * agent is off the schedule (disabled or budget-paused), in which case
 * `nextHeartbeatAt` is null.
 *
 * When the agent has no actionable work (`hasActionableWork` is false) the next
 * heartbeat would fire but find nothing to do — a no-op — so we show a dash
 * instead of a misleading "due now" / countdown. The heartbeat clock keeps
 * ticking server-side; there is simply nothing for it to act on yet.
 */
export function NextHeartbeatIndicator({
	nextHeartbeatAt,
	hasActionableWork,
	className = '',
}: {
	nextHeartbeatAt: string | null;
	hasActionableWork: boolean;
	className?: string;
}) {
	// Only run the live timer when there is work to count down to; passing null
	// when idle stops the per-second interval.
	const countdown = useNextHeartbeatCountdown(hasActionableWork ? nextHeartbeatAt : null);
	if (!nextHeartbeatAt) return null;
	if (hasActionableWork && !countdown) return null;

	const label = hasActionableWork ? countdown!.label : '—';
	const isDue = hasActionableWork && countdown!.isDue;

	return (
		<span
			data-testid="next-heartbeat"
			title={
				hasActionableWork
					? `Next heartbeat ${new Date(nextHeartbeatAt).toLocaleString()}`
					: 'No tasks to work on yet'
			}
			className={`inline-flex items-center gap-1.5 text-xs text-text-2 ${className}`}
		>
			<Activity
				className={`h-3.5 w-3.5 text-text-3 ${isDue ? 'animate-pulse' : ''}`}
				aria-hidden="true"
			/>
			<span className="whitespace-nowrap">
				<span className="text-text-3">Next heartbeat</span> {label}
			</span>
		</span>
	);
}

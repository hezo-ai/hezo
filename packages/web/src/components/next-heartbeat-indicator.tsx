import { Activity } from 'lucide-react';
import { useNextHeartbeatCountdown } from '../hooks/use-next-heartbeat';

/**
 * Live "Next heartbeat in …" countdown for an agent. Renders nothing when the
 * agent is off the schedule (disabled or budget-paused), in which case
 * `nextHeartbeatAt` is null.
 */
export function NextHeartbeatIndicator({
	nextHeartbeatAt,
	className = '',
}: {
	nextHeartbeatAt: string | null;
	className?: string;
}) {
	const countdown = useNextHeartbeatCountdown(nextHeartbeatAt);
	if (!countdown || !nextHeartbeatAt) return null;

	return (
		<span
			data-testid="next-heartbeat"
			title={`Next heartbeat ${new Date(nextHeartbeatAt).toLocaleString()}`}
			className={`inline-flex items-center gap-1.5 text-xs text-text-2 ${className}`}
		>
			<Activity
				className={`h-3.5 w-3.5 text-text-3 ${countdown.isDue ? 'animate-pulse' : ''}`}
				aria-hidden="true"
			/>
			<span className="whitespace-nowrap">
				<span className="text-text-3">Next heartbeat</span> {countdown.label}
			</span>
		</span>
	);
}

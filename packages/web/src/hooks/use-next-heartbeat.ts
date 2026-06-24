import { useEffect, useState } from 'react';
import { formatElapsed } from './use-elapsed-duration';

export interface HeartbeatCountdown {
	/** Human label, e.g. "in 12m30s" or "due now". */
	label: string;
	/** True once the scheduled time has passed — a heartbeat is imminent. */
	isDue: boolean;
}

/**
 * Pure: turn the milliseconds remaining until the next heartbeat into a display
 * label. At or past the scheduled time the heartbeat is due (the scheduler fires
 * within a few seconds), so we stop counting down and say "due now".
 */
export function describeHeartbeatCountdown(remainingMs: number): HeartbeatCountdown {
	if (remainingMs <= 0) return { label: 'due now', isDue: true };
	return { label: `in ${formatElapsed(remainingMs)}`, isDue: false };
}

/**
 * Live countdown to an agent's next scheduled heartbeat. Ticks once a second
 * while a time is set. Returns null when the agent is off the schedule
 * (`nextHeartbeatAt` is null) or the timestamp is unparseable, so callers can
 * render nothing. When the heartbeat fires, the realtime `member_agents`
 * invalidation refetches the agent and `nextHeartbeatAt` rolls forward, which
 * restarts the timer.
 */
export function useNextHeartbeatCountdown(
	nextHeartbeatAt: string | null,
): HeartbeatCountdown | null {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (!nextHeartbeatAt) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [nextHeartbeatAt]);

	if (!nextHeartbeatAt) return null;
	const target = new Date(nextHeartbeatAt).getTime();
	if (Number.isNaN(target)) return null;
	return describeHeartbeatCountdown(target - now);
}

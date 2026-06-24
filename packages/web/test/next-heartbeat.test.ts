import { expect, test } from 'vitest';
import { describeHeartbeatCountdown } from '../src/hooks/use-next-heartbeat';

test('counts down to a future heartbeat', () => {
	expect(describeHeartbeatCountdown(90_000)).toEqual({ label: 'in 1m30s', isDue: false });
	expect(describeHeartbeatCountdown(60 * 60_000)).toEqual({ label: 'in 1h0m0s', isDue: false });
	expect(describeHeartbeatCountdown(5_000)).toEqual({ label: 'in 5s', isDue: false });
});

test('reports due once the scheduled time has passed', () => {
	expect(describeHeartbeatCountdown(0)).toEqual({ label: 'due now', isDue: true });
	expect(describeHeartbeatCountdown(-5_000)).toEqual({ label: 'due now', isDue: true });
});

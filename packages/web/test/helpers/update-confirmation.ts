import { expect } from 'vitest';

export function expectAccurateUpdateRestartCopy(dialog: HTMLElement, runsInFlight: number) {
	expect(dialog.textContent).toContain(`${runsInFlight} agent runs are in flight right now.`);
	expect(dialog.textContent).toContain(
		'Hezo waits a few seconds for agent runs in flight to finish, then stops. Anything still running is re-queued and starts over.',
	);
	expect(dialog.textContent).not.toContain('paused and resume automatically');
}

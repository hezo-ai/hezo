import { expect } from 'vitest';

export function expectAccurateUpdateRestartCopy(dialog: HTMLElement, runsInFlight: number) {
	expect(dialog.textContent).toContain(`${runsInFlight} agent runs are in flight right now.`);
	expect(dialog.textContent).toContain(
		'Hezo stops agent runs in flight, re-queues them, and starts them over.',
	);
	expect(dialog.textContent).not.toContain('waits a few seconds');
	expect(dialog.textContent).not.toContain('paused and resume automatically');
}

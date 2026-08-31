import { expect } from 'vitest';

export function expectAccurateUpdateRestartCopy(dialog: HTMLElement, runsInFlight: number) {
	expect(dialog.textContent).toContain(`${runsInFlight} agent runs are in flight right now.`);
	expect(dialog.textContent).toContain(
		'Hezo stops agent runs in flight, re-queues them, and starts them over.',
	);
	expect(dialog.textContent).not.toContain('waits a few seconds');
	expect(dialog.textContent).not.toContain('paused and resume automatically');
	expect(dialog.textContent).toContain(
		'Keep your 12-word master key handy. New Hezo processes start locked by default. This supervised in-app update can pass the key to the replacement process in memory. After a reboot, crash, or direct service restart, unlock Hezo again unless that startup receives the key once through --master-key or HEZO_MASTER_KEY.',
	);
}

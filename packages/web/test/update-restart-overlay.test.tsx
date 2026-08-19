import { render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	evaluateRestartPoll,
	UpdateRestartOverlay,
} from '../src/components/update-restart-overlay';

describe('evaluateRestartPoll', () => {
	test('reloads once the reported version differs from the one we left', () => {
		// The booting new binary already carries the new version in its `starting`
		// response, so we detect the swap even before it is fully ready.
		expect(
			evaluateRestartPoll(
				{ fromVersion: '0.1.0', wentDown: false },
				{ ok: true, starting: true, version: '0.2.0' },
			),
		).toEqual({ reload: true, wentDown: false });
	});

	test('a network error / non-ok marks the server as down (no reload yet)', () => {
		expect(
			evaluateRestartPoll(
				{ fromVersion: '0.1.0', wentDown: false },
				{ ok: false, starting: false, version: null },
			),
		).toEqual({ reload: false, wentDown: true });
	});

	test('a booting server on the same version is not treated as up', () => {
		expect(
			evaluateRestartPoll(
				{ fromVersion: '0.1.0', wentDown: false },
				{ ok: true, starting: true, version: '0.1.0' },
			),
		).toEqual({ reload: false, wentDown: false });
	});

	test('same-version restart recovers via the went-down → back-up fallback', () => {
		expect(
			evaluateRestartPoll(
				{ fromVersion: '0.1.0', wentDown: true },
				{ ok: true, starting: false, version: '0.1.0' },
			),
		).toEqual({ reload: true, wentDown: true });
	});

	test('a healthy server still on the old binary does not reload', () => {
		expect(
			evaluateRestartPoll(
				{ fromVersion: '0.1.0', wentDown: false },
				{ ok: true, starting: false, version: '0.1.0' },
			),
		).toEqual({ reload: false, wentDown: false });
	});
});

describe('UpdateRestartOverlay copy', () => {
	afterEach(() => vi.restoreAllMocks());

	// The immediate poll would hit `/api/status`; reject it so the overlay just
	// renders (never reaches `window.location.reload`).
	function renderOverlay() {
		vi.spyOn(global, 'fetch').mockRejectedValue(new Error('down'));
		return render(<UpdateRestartOverlay fromVersion="0.1.0" />);
	}

	test('says only that the server is restarting', () => {
		const { getByTestId } = renderOverlay();
		expect(getByTestId('update-restart-overlay').textContent).toBe('Restarting…');
	});

	// Nothing here is actionable while the server is down, and the confirm dialog
	// already carried the version, the run consequence and the master-key warning.
	test('repeats none of the confirm dialog', () => {
		const { getByTestId } = renderOverlay();
		const text = getByTestId('update-restart-overlay').textContent ?? '';
		expect(text).not.toContain('master key');
		expect(text).not.toContain('0.');
		expect(text).not.toContain('agent runs');
	});
});

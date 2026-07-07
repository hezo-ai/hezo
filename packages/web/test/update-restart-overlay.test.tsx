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
	function renderOverlay(props: { autoUnlock: boolean }) {
		vi.spyOn(global, 'fetch').mockRejectedValue(new Error('down'));
		return render(<UpdateRestartOverlay targetVersion="0.2.0" fromVersion="0.1.0" {...props} />);
	}

	test('warns about the master key when the instance comes back locked', () => {
		const { getByTestId } = renderOverlay({ autoUnlock: false });
		const text = getByTestId('update-restart-overlay').textContent ?? '';
		expect(text).toContain("you'll need your 12-word master key");
		expect(text).not.toContain('no master key needed');
	});

	test('reassures instead of warning when the instance auto-unlocks', () => {
		const { getByTestId } = renderOverlay({ autoUnlock: true });
		const text = getByTestId('update-restart-overlay').textContent ?? '';
		expect(text).toContain('no master key needed');
		expect(text).not.toContain("you'll need your 12-word master key");
	});
});

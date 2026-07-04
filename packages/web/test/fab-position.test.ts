// Unit tests for the draggable-FAB position store and its geometry helpers:
// the in-memory per-button map, frac clamping on write, and the px<->frac
// conversions staying fully on-screen including degenerate viewports.
import { beforeEach, describe, expect, test } from 'vitest';
import {
	fabPixelPosition,
	getFabPosition,
	pixelsToFabPosition,
	resetFabPositions,
	setFabPosition,
} from '../src/lib/fab-position';

beforeEach(() => {
	resetFabPositions();
});

describe('in-memory store', () => {
	test('returns null before any position is set', () => {
		expect(getFabPosition('ceo-chat')).toBeNull();
	});

	test('stores a position and the latest write wins', () => {
		setFabPosition('ceo-chat', { xFrac: 0.25, yFrac: 0.5 });
		expect(getFabPosition('ceo-chat')).toEqual({ xFrac: 0.25, yFrac: 0.5 });
		setFabPosition('ceo-chat', { xFrac: 0.9, yFrac: 0.1 });
		expect(getFabPosition('ceo-chat')).toEqual({ xFrac: 0.9, yFrac: 0.1 });
	});

	test('clamps fractions to [0,1] on write and rejects non-finite values', () => {
		setFabPosition('ceo-chat', { xFrac: -3, yFrac: 42 });
		expect(getFabPosition('ceo-chat')).toEqual({ xFrac: 0, yFrac: 1 });
		// Non-finite values are garbage, not "very far right" — they zero out.
		setFabPosition('ceo-chat', { xFrac: Number.NaN, yFrac: Number.POSITIVE_INFINITY });
		expect(getFabPosition('ceo-chat')).toEqual({ xFrac: 0, yFrac: 0 });
	});

	test('reset clears every stored position', () => {
		setFabPosition('ceo-chat', { xFrac: 0.5, yFrac: 0.5 });
		resetFabPositions();
		expect(getFabPosition('ceo-chat')).toBeNull();
	});
});

describe('fabPixelPosition', () => {
	test('maps fractions over the free range (viewport minus button)', () => {
		// 375x800 viewport, 48px button: free range is 327x752.
		expect(fabPixelPosition({ xFrac: 0, yFrac: 0 }, 48, 48, 375, 800)).toEqual({
			left: 0,
			top: 0,
		});
		expect(fabPixelPosition({ xFrac: 1, yFrac: 1 }, 48, 48, 375, 800)).toEqual({
			left: 327,
			top: 752,
		});
		expect(fabPixelPosition({ xFrac: 0.5, yFrac: 0.5 }, 48, 48, 375, 800)).toEqual({
			left: 163.5,
			top: 376,
		});
	});

	test('degenerate viewport smaller than the button pins to the origin', () => {
		expect(fabPixelPosition({ xFrac: 1, yFrac: 1 }, 48, 48, 30, 30)).toEqual({ left: 0, top: 0 });
	});
});

describe('pixelsToFabPosition', () => {
	test('inverts fabPixelPosition inside the viewport', () => {
		const pos = pixelsToFabPosition(163.5, 376, 48, 48, 375, 800);
		expect(pos.xFrac).toBeCloseTo(0.5);
		expect(pos.yFrac).toBeCloseTo(0.5);
	});

	test('clamps drops beyond the viewport edges', () => {
		expect(pixelsToFabPosition(-100, 9999, 48, 48, 375, 800)).toEqual({ xFrac: 0, yFrac: 1 });
	});

	test('degenerate free range maps to 0', () => {
		expect(pixelsToFabPosition(10, 10, 48, 48, 40, 40)).toEqual({ xFrac: 0, yFrac: 0 });
	});
});

describe('round trip', () => {
	test('a dragged spot re-resolves to the same relative position after rotation', () => {
		// Drop at bottom-right-ish in portrait…
		const pos = pixelsToFabPosition(300, 700, 48, 48, 375, 800);
		// …then rotate to landscape: still bottom-right-ish, fully on-screen.
		const { left, top } = fabPixelPosition(pos, 48, 48, 800, 375);
		expect(left).toBeGreaterThan(0);
		expect(left).toBeLessThanOrEqual(800 - 48);
		expect(top).toBeLessThanOrEqual(375 - 48);
		expect(left / (800 - 48)).toBeCloseTo(300 / (375 - 48));
	});
});

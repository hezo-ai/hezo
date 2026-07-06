import { afterEach, beforeEach, expect, test } from 'vitest';
import {
	clampPanelWidth,
	MAX_PANEL_WIDTH,
	MIN_MAIN_WIDTH,
	MIN_PANEL_WIDTH,
	readStoredPanelWidth,
	writeStoredPanelWidth,
} from '../src/lib/panel-width-storage';

const KEY = 'hezo:test-panel-width';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

test('read returns null when nothing is stored', () => {
	expect(readStoredPanelWidth(KEY)).toBeNull();
});

test('read returns null for non-numeric / malformed values', () => {
	localStorage.setItem(KEY, 'not-a-number');
	expect(readStoredPanelWidth(KEY)).toBeNull();
	localStorage.setItem(KEY, '');
	expect(readStoredPanelWidth(KEY)).toBeNull();
});

test('write then read round-trips a valid width', () => {
	writeStoredPanelWidth(KEY, 480);
	expect(readStoredPanelWidth(KEY)).toBe(480);
});

test('read clamps a stored value that is out of the absolute range', () => {
	localStorage.setItem(KEY, '10'); // below MIN
	expect(readStoredPanelWidth(KEY)).toBe(MIN_PANEL_WIDTH);
	localStorage.setItem(KEY, '5000'); // above MAX
	expect(readStoredPanelWidth(KEY)).toBe(MAX_PANEL_WIDTH);
});

test('write clamps before persisting', () => {
	writeStoredPanelWidth(KEY, 5); // below MIN
	expect(localStorage.getItem(KEY)).toBe(String(MIN_PANEL_WIDTH));
});

test('clampPanelWidth honours the container-based max (main column keeps MIN_MAIN_WIDTH)', () => {
	const container = 1000;
	// A width that would leave the main column below MIN_MAIN_WIDTH is capped.
	expect(clampPanelWidth(900, container)).toBe(container - MIN_MAIN_WIDTH);
	// A comfortable width passes through untouched.
	expect(clampPanelWidth(400, container)).toBe(400);
	// Never returns below the floor even on a very narrow container.
	expect(clampPanelWidth(400, 500)).toBe(MIN_PANEL_WIDTH);
});

test('clampPanelWidth without a container uses only the absolute bounds', () => {
	expect(clampPanelWidth(9999)).toBe(MAX_PANEL_WIDTH);
	expect(clampPanelWidth(1)).toBe(MIN_PANEL_WIDTH);
	expect(clampPanelWidth(600)).toBe(600);
});

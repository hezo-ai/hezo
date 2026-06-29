// Unit tests for the theme context: preference initialization from storage,
// system-theme resolution via matchMedia, persistence on change, the
// prefers-color-scheme change listener (active only for the `system`
// preference), and the useTheme guard. Rendered with renderHook (no app shell).
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { writeStored } from '../src/lib/safe-storage';
import { ThemeProvider, useTheme } from '../src/lib/theme';

const STORAGE_KEY = 'theme';

/** A controllable matchMedia returning `matches` and capturing change listeners. */
function installMatchMedia(matches: boolean) {
	const listeners = new Set<() => void>();
	const mql = {
		matches,
		media: '(prefers-color-scheme: dark)',
		onchange: null,
		addEventListener: (_type: string, cb: () => void) => listeners.add(cb),
		removeEventListener: (_type: string, cb: () => void) => listeners.delete(cb),
		addListener: (cb: () => void) => listeners.add(cb),
		removeListener: (cb: () => void) => listeners.delete(cb),
		dispatchEvent: () => true,
	};
	const spy = vi.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList);
	return {
		spy,
		listeners,
		/** Flip the system preference and fire the captured change listeners. */
		setMatches(next: boolean) {
			mql.matches = next;
			for (const cb of listeners) cb();
		},
	};
}

function wrapper({ children }: { children: ReactNode }) {
	return <ThemeProvider>{children}</ThemeProvider>;
}

describe('ThemeProvider', () => {
	beforeEach(() => {
		localStorage.clear();
		document.documentElement.classList.remove('light', 'dark');
	});
	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
		document.documentElement.classList.remove('light', 'dark');
	});

	test('defaults to system preference with no stored value, resolving via matchMedia (dark)', () => {
		installMatchMedia(true);
		const { result } = renderHook(() => useTheme(), { wrapper });
		expect(result.current.preference).toBe('system');
		expect(result.current.resolvedTheme).toBe('dark');
		expect(document.documentElement.classList.contains('dark')).toBe(true);
		expect(document.documentElement.classList.contains('light')).toBe(false);
	});

	test('system preference resolves to light when matchMedia does not match dark', () => {
		installMatchMedia(false);
		const { result } = renderHook(() => useTheme(), { wrapper });
		expect(result.current.resolvedTheme).toBe('light');
		expect(document.documentElement.classList.contains('light')).toBe(true);
	});

	test('reads an explicit stored "dark" preference', () => {
		writeStored(STORAGE_KEY, 'dark');
		installMatchMedia(false); // system says light, but explicit dark wins
		const { result } = renderHook(() => useTheme(), { wrapper });
		expect(result.current.preference).toBe('dark');
		expect(result.current.resolvedTheme).toBe('dark');
		expect(document.documentElement.classList.contains('dark')).toBe(true);
	});

	test('reads an explicit stored "light" preference', () => {
		writeStored(STORAGE_KEY, 'light');
		installMatchMedia(true); // system says dark, but explicit light wins
		const { result } = renderHook(() => useTheme(), { wrapper });
		expect(result.current.preference).toBe('light');
		expect(result.current.resolvedTheme).toBe('light');
	});

	test('falls back to system for an unrecognized stored value', () => {
		writeStored(STORAGE_KEY, 'neon');
		installMatchMedia(true);
		const { result } = renderHook(() => useTheme(), { wrapper });
		expect(result.current.preference).toBe('system');
		expect(result.current.resolvedTheme).toBe('dark');
	});

	test('setPreference updates resolved theme, applies the class, and persists', () => {
		installMatchMedia(false);
		const { result } = renderHook(() => useTheme(), { wrapper });

		act(() => result.current.setPreference('dark'));

		expect(result.current.preference).toBe('dark');
		expect(result.current.resolvedTheme).toBe('dark');
		expect(document.documentElement.classList.contains('dark')).toBe(true);
		expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
	});

	test('switching from dark to light swaps the root class (no stale class left)', () => {
		writeStored(STORAGE_KEY, 'dark');
		installMatchMedia(false);
		const { result } = renderHook(() => useTheme(), { wrapper });
		expect(document.documentElement.classList.contains('dark')).toBe(true);

		act(() => result.current.setPreference('light'));

		expect(document.documentElement.classList.contains('light')).toBe(true);
		expect(document.documentElement.classList.contains('dark')).toBe(false);
	});

	test('on system preference, a prefers-color-scheme change re-resolves and re-applies', () => {
		const mm = installMatchMedia(false);
		const { result } = renderHook(() => useTheme(), { wrapper });
		expect(result.current.resolvedTheme).toBe('light');

		act(() => mm.setMatches(true));

		expect(result.current.resolvedTheme).toBe('dark');
		expect(document.documentElement.classList.contains('dark')).toBe(true);
	});

	test('an explicit (non-system) preference ignores prefers-color-scheme changes', () => {
		writeStored(STORAGE_KEY, 'light');
		const mm = installMatchMedia(false);
		const { result } = renderHook(() => useTheme(), { wrapper });
		expect(result.current.resolvedTheme).toBe('light');

		// No change listener should be registered for an explicit preference.
		expect(mm.listeners.size).toBe(0);
		act(() => mm.setMatches(true));
		expect(result.current.resolvedTheme).toBe('light');
	});

	test('switching to system after the change listener mounts then unmounts on explicit', () => {
		const mm = installMatchMedia(false);
		const { result } = renderHook(() => useTheme(), { wrapper });
		// system preference => one listener registered.
		expect(mm.listeners.size).toBe(1);

		act(() => result.current.setPreference('dark'));
		// effect cleanup removes the listener for the now-explicit preference.
		expect(mm.listeners.size).toBe(0);
	});

	test('useTheme throws when used outside a ThemeProvider', () => {
		// renderHook surfaces the thrown error rather than crashing the suite.
		expect(() => renderHook(() => useTheme())).toThrow(
			'useTheme must be used within a ThemeProvider',
		);
	});
});

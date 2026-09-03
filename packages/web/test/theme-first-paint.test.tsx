import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { THEME_STORAGE_KEY, ThemeProvider } from '../src/lib/theme';
import { installMatchMedia } from './helpers/match-media';

/**
 * The pre-paint script and the provider, held in step.
 *
 * The script runs before any module loads, so it cannot import the key or the
 * resolution it duplicates. Nothing else can see the pair: a drifted key comes
 * up as a flash on every load, and a drifted resolution as a flash only on the
 * explicit-light path of a dark-system machine. So the assertions land on the
 * committed file rather than on a re-implementation of it.
 */
const HTML = readFileSync(
	resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'),
	'utf8',
);

const INLINE = (() => {
	const bodies = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
	const themed = bodies.filter((b) => b.includes('prefers-color-scheme'));
	expect(themed, 'exactly one pre-paint theme script in index.html').toHaveLength(1);
	return themed[0];
})();

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
	document.documentElement.className = '';
});

test('the pre-paint script reads the key the provider writes', () => {
	const keys = [...INLINE.matchAll(/localStorage\.getItem\(\s*'([^']*)'\s*\)/g)].map((m) => m[1]);
	// The whole list, not a `.includes`: a second read must not let a drifted key hide.
	expect(keys).toEqual([THEME_STORAGE_KEY]);
});

test('the pre-paint script runs before the app bundle', () => {
	// A key guard that passes while the script has moved below the bundle reports
	// green on the very thing it exists to catch.
	expect(HTML.indexOf(INLINE)).toBeLessThan(HTML.indexOf('/src/main.tsx'));
});

const CASES = [
	{ stored: null, systemDark: true },
	{ stored: null, systemDark: false },
	{ stored: 'dark', systemDark: false },
	{ stored: 'light', systemDark: true },
	{ stored: 'system', systemDark: true },
	// An unrecognized value is not a preference, and both paths have to agree it isn't.
	{ stored: 'neon', systemDark: false },
] as const;

test.each(
	CASES,
)('script and provider paint the same theme (stored=$stored, systemDark=$systemDark)', ({
	stored,
	systemDark,
}) => {
	const seed = () => {
		document.documentElement.className = '';
		localStorage.clear();
		if (stored !== null) localStorage.setItem(THEME_STORAGE_KEY, stored);
		installMatchMedia(systemDark);
	};

	seed();
	new Function(INLINE)();
	const fromScript = document.documentElement.className;

	seed();
	render(
		<ThemeProvider>
			<span />
		</ThemeProvider>,
	);
	const fromProvider = document.documentElement.className;

	expect(fromScript).toBe(fromProvider);
});

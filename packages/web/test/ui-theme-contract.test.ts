import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

// Tailwind emits a colour utility only when the theme key behind it exists, so
// a primitive naming a colour this stylesheet never defines renders with no
// colour at all - no error, nothing in the markup. The package documents the
// surface a consumer has to supply; this checks the consumer actually supplies
// it, and by extension that the documented list is not short.

const WEB = resolve(__dirname, '..');
const UI_SRC = resolve(WEB, '../ui/src');

/** Utilities whose suffix is a keyword, a size or a side, never a theme colour. */
const NOT_A_COLOUR =
	/-(transparent|current|inherit|white|black|none|auto|solid|dashed|dotted|hidden|visible|collapse|separate|clip|ellipsis|nowrap|wrap|balance|pretty|left|right|center|top|bottom|start|end|color|xs|sm|base|md|lg|xl|\dxl|[trblxy]|\d.*)$/;

const COLOUR_UTILITY =
	/(?<![\w-])(?:bg|text|border|ring-offset|ring|fill|stroke|decoration|outline|divide|placeholder|caret|shadow)-([a-z][a-z0-9-]*)/g;

function usedColourNames(): Set<string> {
	const names = new Set<string>();
	for (const file of readdirSync(UI_SRC, { recursive: true, encoding: 'utf8' })) {
		if (!/\.tsx?$/.test(file)) continue;
		// Comments are prose, and prose contains hyphenated words that read as
		// utilities ("a text-entry surface").
		const source = readFileSync(resolve(UI_SRC, file), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
		for (const [utility, name] of source.matchAll(COLOUR_UTILITY)) {
			if (!NOT_A_COLOUR.test(utility)) names.add(`${utility}\u0000${name}`);
		}
	}
	return names;
}

test('every colour the primitives name is defined by this stylesheet', () => {
	const css = readFileSync(resolve(WEB, 'src/index.css'), 'utf8');
	const themeKeys = new Set([...css.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]));
	// A custom `@utility` carries its own colour, so it needs no theme key.
	const utilities = new Set([...css.matchAll(/@utility\s+([a-z0-9-]+)/g)].map((m) => m[1]));

	const used = usedColourNames();
	expect(used.size).toBeGreaterThan(20);

	const undefined_ = [...used]
		.filter((entry) => {
			const [utility, name] = entry.split('\u0000');
			return !themeKeys.has(name) && !utilities.has(utility);
		})
		.map((entry) => entry.split('\u0000')[0])
		.sort();
	expect(undefined_, 'primitives name colours this stylesheet never defines').toEqual([]);
});

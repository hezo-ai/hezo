import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from 'vitest';

// Tailwind generates a utility only where it reads the class string, and its
// scan root stops at this package. A workspace package holding components the
// app renders therefore has to be named explicitly, or every utility used only
// by one of its components is absent from the stylesheet - the component then
// renders unstyled, with nothing in the markup or the build output to say so.
//
// This checks the declaration and that it resolves onto real source, not that a
// particular class survives a build; observing that needs the build itself.

const WEB = resolve(__dirname, '..');
const STYLESHEET = resolve(WEB, 'src/index.css');

function declaredSources(): string[] {
	const css = readFileSync(STYLESHEET, 'utf8');
	return [...css.matchAll(/@source\s+['"]([^'"]+)['"]/g)].map((m) =>
		resolve(dirname(STYLESHEET), m[1]),
	);
}

/** Workspace siblings this package depends on, as absolute source directories. */
function workspaceDependencies(): { name: string; src: string }[] {
	const pkg = JSON.parse(readFileSync(resolve(WEB, 'package.json'), 'utf8')) as {
		dependencies?: Record<string, string>;
	};
	return Object.entries(pkg.dependencies ?? {})
		.filter(([, range]) => range.startsWith('workspace:'))
		.map(([name]) => ({ name, src: resolve(WEB, '..', name.replace('@hezo/', ''), 'src') }));
}

/** A package draws with Tailwind when its source carries class strings. */
function rendersMarkup(src: string): boolean {
	return readdirSync(src, { recursive: true, encoding: 'utf8' }).some((f) => f.endsWith('.tsx'));
}

test('every workspace package rendering markup is named by an @source', () => {
	const declared = declaredSources();
	const drawing = workspaceDependencies().filter((d) => rendersMarkup(d.src));

	expect(drawing.map((d) => d.name)).toContain('@hezo/ui');
	for (const dep of drawing) {
		expect(declared, `${dep.name} renders markup but ${dep.src} is unscanned`).toContain(dep.src);
	}
});

test('each declared source points at source that exists', () => {
	for (const src of declaredSources()) {
		expect(readdirSync(src).length, `${src} is declared but empty`).toBeGreaterThan(0);
	}
});

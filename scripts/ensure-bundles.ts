#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

// The embed bundles are generated artifacts (gitignored) that real builds fill
// with content via `build:migrations` / `build:agents` / `build:static`. But the
// consuming source files use a *literal* `import('./xxx-bundle.json')` so
// `bun build --compile` can embed them — and a literal specifier is statically
// resolved by tsc (the `build` job) and vite (the web/server vitest transform),
// both of which error when the file is absent. Writing an empty stub satisfies
// that static resolution; at runtime an empty bundle is treated as "not
// generated" and the loaders fall back to the filesystem (see migrate.ts /
// agent-roles.ts / static-assets.ts). Existing non-empty bundles are left
// untouched, so this never clobbers real generated content.
const BUNDLES = [
	'packages/server/src/db/migrations-bundle.json',
	'packages/server/src/db/agents-bundle.json',
	'packages/server/src/services/docs-bundle.json',
	'packages/server/src/static-bundle.json',
	'packages/server/src/docker-bundle.json',
];

export function ensureBundles(): void {
	for (const rel of BUNDLES) {
		const path = resolve(ROOT, rel);
		if (!existsSync(path)) {
			writeFileSync(path, '{}\n');
			console.log(`Wrote stub bundle: ${rel}`);
		}
	}
}

if (import.meta.main) {
	ensureBundles();
}

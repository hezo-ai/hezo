import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const __dir = resolve(import.meta.dirname ?? '.');

// Bun may hoist react to the repo root or leave it under a package — and a
// render() that pulls in two copies blows up on useState. Resolve once from
// this config's location and force every import through that path.
const requireFromUi = createRequire(import.meta.url);
const reactDir = dirname(requireFromUi.resolve('react/package.json'));
const reactDomDir = dirname(requireFromUi.resolve('react-dom/package.json'));

// The package's own tier. It exists so the primitives are exercised **without**
// the app around them: the web suite always supplies a translation context and
// a router, so it cannot catch a `useI18n()` creeping back into a primitive,
// which is the one thing that would make the package unimportable again.
export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			react: reactDir,
			'react-dom': reactDomDir,
		},
	},
	test: {
		globals: true,
		environment: 'happy-dom',
		setupFiles: ['test/setup.ts'],
		include: ['test/**/*.test.{ts,tsx}'],
		root: __dir,
		coverage: {
			provider: 'v8',
			enabled: false,
			// `json` writes coverage-final.json for CI's cross-tier merge; see
			// scripts/coverage/.
			reporter: ['text-summary', 'json'],
			reportsDirectory: './coverage',
			reportOnFailure: true,
			all: false,
			include: ['src/**/*.{ts,tsx}'],
			exclude: ['src/**/*.d.ts'],
		},
	},
});

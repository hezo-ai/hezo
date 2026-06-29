import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const __dir = resolve(import.meta.dirname ?? '.');
const ROOT = resolve(__dir, '../..');

// Component-tier test config. Tests render the React tree against an
// in-process Hono + PGlite backend in happy-dom, so they exercise the same
// API surface as the Playwright e2e tests with ~100x less per-test overhead.
// Tests live alongside the package (packages/web/test/**); the Playwright
// e2e suite stays in the root test/e2e/ tree.
export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			// Workspace packages have no `exports` field, so subpath imports like
			// `@hezo/server/test/helpers/app` don't resolve through the workspace
			// dep alone. Alias bare specifiers to the source trees. The
			// `@hezo/server/test` entry must come first so it wins over the
			// broader `@hezo/server` prefix.
			'@hezo/server/test': resolve(ROOT, 'packages/server/test'),
			'@hezo/server': resolve(ROOT, 'packages/server/src'),
			'@hezo/web': resolve(__dir, 'src'),
			'@hezo/shared': resolve(ROOT, 'packages/shared/src/index.ts'),
			// Bun keeps multiple react installs around (different peer requesters
			// pull different patch versions) and a render() that pulls in two
			// copies blows up on useState. Force every import through one path so
			// React's hook dispatcher is shared.
			react: resolve(__dir, 'node_modules/react'),
			'react-dom': resolve(__dir, 'node_modules/react-dom'),
		},
	},
	test: {
		globals: true,
		environment: 'happy-dom',
		include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
		setupFiles: ['test/helpers/setup.ts'],
		// Matcher ceilings of 20_000 / 30_000ms appear throughout the suite;
		// the per-test cap has to exceed them or the test-level timeout fires
		// first on a contended CI runner (4 forks × PGlite + Hono boot) and
		// the matcher's grace window never actually applies.
		testTimeout: 45000,
		hookTimeout: 45000,
		// 4 forks each booting PGlite + Hono on a 2-core CI runner is deliberate
		// oversubscription, so a spec can occasionally lose a scheduling race and
		// time out waiting for a slow refetch — an environmental flake. Retry twice
		// on CI; a real failure still fails all three attempts. Off locally so a
		// genuine break surfaces immediately.
		retry: process.env.CI ? 2 : 0,
		pool: 'forks',
		poolOptions: {
			forks: {
				isolate: true,
			},
		},
		// db.ts walks import.meta.url to find packages/server/migrations, but
		// vite rewrites that to a /@fs/... URL whose fileURLToPath rejects. Hand
		// the absolute paths through explicitly so the bundled server code
		// doesn't fall back to a broken resolver.
		env: {
			HEZO_MIGRATIONS_DIR: resolve(ROOT, 'packages/server/migrations'),
			HEZO_AGENTS_DIR: resolve(ROOT, 'agents'),
			HEZO_E2E_SKIP_COHERENCE_REVIEW: '1',
			HEZO_SKIP_DOCKER: '1',
			SKIP_AI_KEY_VALIDATION: '1',
		},
		// Off by default so normal runs stay uninstrumented; scripts/test.ts
		// flips `enabled` on with --coverage. coverage-v8 remaps through the same
		// vite transform sourcemaps the suite already runs under, so React/JSX +
		// the path aliases above resolve back to src/** correctly.
		coverage: {
			provider: 'v8',
			enabled: false,
			reporter: ['text-summary', 'json', 'lcov'],
			reportsDirectory: './coverage',
			reportOnFailure: true,
			// See the server config for why all:false is mandatory under sharding.
			all: false,
			include: ['src/**/*.{ts,tsx}'],
			exclude: [
				'src/**/*.d.ts',
				'src/routeTree.gen.ts',
				'src/main.tsx',
				'src/vite-env.d.ts',
				'src/**/*.test.{ts,tsx}',
				'test/**',
				'dist/**',
			],
		},
	},
});

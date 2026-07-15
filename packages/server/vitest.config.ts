import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		include: ['test/**/*.test.ts'],
		// test/bun/** runs under Bun's native runner (`bun test`), not vitest —
		// it imports `bun:test` and exercises the production Bun runtime.
		exclude: [...configDefaults.exclude, 'test/bun/**'],
		setupFiles: ['test/setup.ts'],
		testTimeout: 60000,
		hookTimeout: 60000,
		// Collapse the password-verifier KDF to its cheapest valid cost (scrypt
		// N=2**1). Every createTestApp enrolls a verifier; at the production cost
		// (N=2**15) that is ~280ms of pure overhead per test. Honoured only under
		// NODE_ENV=test and clamped to lower-only — see passwordScryptParams in
		// packages/shared/src/crypto/auth.ts.
		env: {
			HEZO_TEST_SCRYPT_LOG_N: '1',
			// Read marketplace team templates from the committed repo folder (never the
			// network) so provisioning tests are deterministic and offline.
			HEZO_MARKETPLACE_DIR: fileURLToPath(new URL('../../marketplace', import.meta.url)),
		},
		pool: 'forks',
		poolOptions: {
			forks: {
				isolate: true,
			},
		},
		// Off by default so normal runs stay uninstrumented; scripts/test.ts
		// flips `enabled` on with --coverage. The `json` reporter writes the
		// istanbul coverage-final.json that CI's merge job combines across shards
		// (branches keyed by source location, not per-run ordinals — see
		// scripts/coverage/). No per-tier `lcov` reporter: nothing consumes it.
		coverage: {
			provider: 'v8',
			enabled: false,
			reporter: ['text-summary', 'json'],
			reportsDirectory: './coverage',
			// CI uploads with if:always(); a failing shard must still emit a report.
			reportOnFailure: true,
			// MANDATORY under sharding: with `all`, each shard would emit synthetic
			// 0% rows for files it never loaded, polluting the cross-shard merge.
			// With all:false the union across shards equals the full unsharded totals
			// (file-sharding partitions files, no double-count).
			all: false,
			include: ['src/**/*.ts'],
			exclude: [
				'src/**/*.d.ts',
				'src/generated/**',
				'src/**/*.test.ts',
				'test/**',
				'dist/**',
				'src/index.ts',
			],
		},
	},
});

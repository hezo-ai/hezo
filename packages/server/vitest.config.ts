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
		pool: 'forks',
		poolOptions: {
			forks: {
				isolate: true,
			},
		},
		// Off by default so normal runs stay uninstrumented; scripts/test.ts
		// flips `enabled` on with --coverage. CI uploads each tier's lcov to
		// Coveralls as a parallel build; the uploads merge into one total.
		coverage: {
			provider: 'v8',
			enabled: false,
			reporter: ['text-summary', 'json', 'lcov'],
			reportsDirectory: './coverage',
			// CI uploads with if:always(); a failing shard must still emit an lcov.
			reportOnFailure: true,
			// MANDATORY under sharding: with `all`, each shard would emit synthetic
			// 0% rows for files it never loaded, polluting the coverage service's
			// cross-shard merge. With all:false the union across shards equals the
			// full unsharded totals (file-sharding partitions files, no double-count).
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

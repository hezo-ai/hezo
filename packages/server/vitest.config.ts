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
	},
});

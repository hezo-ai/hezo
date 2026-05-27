import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		include: ['test/**/*.test.ts'],
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

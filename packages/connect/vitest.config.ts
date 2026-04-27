import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		include: ['src/test/**/*.test.ts'],
		testTimeout: 30000,
		pool: 'forks',
		poolOptions: {
			forks: {
				isolate: true,
			},
		},
	},
});

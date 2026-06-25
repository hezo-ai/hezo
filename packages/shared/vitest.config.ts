import { defineConfig } from 'vitest/config';

// Unit-tier config for the pure-logic shared package (crypto, mentions, budget,
// pricing, task-progress, enums/constants). No DOM, no backend — plain Node.
// scripts/test.ts runs this package alongside server/web and normalizes its lcov
// to repo-root-relative paths so Coveralls counts packages/shared/src/** too.
export default defineConfig({
	test: {
		globals: true,
		include: ['test/**/*.test.ts'],
		// Off by default so normal runs stay uninstrumented; scripts/test.ts flips
		// `enabled` on with --coverage. Uploaded to Coveralls under the `shared`
		// flag as part of the same parallel build as server/web.
		coverage: {
			provider: 'v8',
			enabled: false,
			reporter: ['text-summary', 'json', 'lcov'],
			reportsDirectory: './coverage',
			reportOnFailure: true,
			all: false,
			include: ['src/**/*.ts'],
			exclude: [
				'src/**/*.d.ts',
				// Pure re-export barrels and type-only modules carry no testable logic.
				'src/index.ts',
				'src/types/index.ts',
				'src/types/config.ts',
				'src/mentions/index.ts',
				'src/**/*.test.ts',
				'test/**',
				'dist/**',
			],
		},
	},
});

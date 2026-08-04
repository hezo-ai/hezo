import { defineConfig } from 'vitest/config';

// Unit-tier config for the pure-logic shared package (crypto, mentions, budget,
// pricing, task-progress, enums/constants). No DOM, no backend — plain Node.
// scripts/test.ts runs this package alongside server/web; CI's merge job combines
// its coverage-final.json into the repo-root-relative total so Coveralls counts
// packages/shared/src/** too.
export default defineConfig({
	test: {
		globals: true,
		include: ['test/**/*.test.ts'],
		// Collapse the password-verifier KDF to its cheapest valid cost (scrypt
		// N=2**1), matching the server and web configs so a direct
		// `cd packages/shared && bunx vitest run` costs the same as a full
		// `bun run test` (which sets this for every tier from scripts/test.ts).
		// Honoured only under NODE_ENV=test and clamped to lower-only — see
		// passwordScryptParams in src/crypto/auth.ts.
		env: {
			HEZO_TEST_SCRYPT_LOG_N: '1',
		},
		// Off by default so normal runs stay uninstrumented; scripts/test.ts flips
		// `enabled` on with --coverage. Its coverage-final.json joins the merged
		// Coveralls total via the merge job (see scripts/coverage/).
		coverage: {
			provider: 'v8',
			enabled: false,
			// `json` writes coverage-final.json for CI's coverage merge job; no
			// per-tier lcov (nothing consumes it). See scripts/coverage/.
			reporter: ['text-summary', 'json'],
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

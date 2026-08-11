import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The live-backend config: the **only** thing that runs `test/live/**`.
 *
 * Those specs provision sandboxes on a paid provider, so they are excluded from
 * the default config and reachable solely through `bun run test:daytona`, which
 * points vitest here. Two guards on top of that:
 *
 * - **CI is refused outright.** Not "skipped if no key": a key reaching CI
 *   through a secret or a fork's environment must not start billing, and a check
 *   that depends on the key being absent is one misconfiguration away from
 *   provisioning on every push.
 * - **One file at a time, no parallelism.** A provider account has a total
 *   sandbox quota, and a suite racing itself against that quota fails as a
 *   provider error rather than as the assertion it was making.
 *
 * Timeouts are minutes, not seconds: a first sandbox is built rather than
 * started, and the build is where the time goes.
 *
 * Spreads the base config rather than `mergeConfig`ing it, deliberately:
 * `mergeConfig` concatenates arrays, so the base's `exclude` - which is what
 * keeps `test/live/**` out of every other run - would survive into the one
 * config whose entire job is to include it, and the suite would silently match
 * nothing.
 */
if (process.env.CI) {
	throw new Error(
		'the live backend suite provisions billable sandboxes and must never run in CI - ' +
			'run it locally with `bun run test:daytona`',
	);
}

const rawSetup = base.test?.setupFiles;
const baseSetupFiles = Array.isArray(rawSetup) ? rawSetup : rawSetup ? [rawSetup] : [];

export default defineConfig({
	test: {
		...base.test,
		include: ['test/live/**/*.test.ts'],
		exclude: [...configDefaults.exclude],
		// On top of the base setup, not instead of it: `test/live/setup.ts` lifts
		// undici's 5-minute header/body timeouts, which Bun does not have and which
		// this tier's long-held log streams run straight into.
		setupFiles: [...baseSetupFiles, 'test/live/setup.ts'],
		testTimeout: 600_000,
		hookTimeout: 600_000,
		// One worker: the provider's quota is the shared resource, and two files
		// provisioning at once exhaust it before either finishes.
		fileParallelism: false,
		maxWorkers: 1,
		env: {
			HEZO_MARKETPLACE_DIR: fileURLToPath(new URL('../../marketplace', import.meta.url)),
		},
	},
});

import { setLogLevel } from '../../src/logger';

/**
 * Quiet the app logger for test runs. The suites emit a high volume of expected
 * `[info]` chatter (seeded teams, provisioned stub containers, applied
 * migrations, job-manager lifecycle, …) that buries real signal; raise the floor
 * to `warn` so `[warn]`/`[error]` stay visible and the "no spurious warn/error
 * in test output" rule stays enforceable. Honour `HEZO_LOG_LEVEL` so a dev can
 * opt back in (`HEZO_LOG_LEVEL=info bun run test`).
 *
 * Lives under `test/helpers` (not `src`) so web tests can import it via the
 * `@hezo/server/test/...` specifier, which resolves identically under both the
 * vitest alias and `tsc`'s workspace-symlink resolution.
 */
export function quietTestLogs(): void {
	const level = process.env.HEZO_LOG_LEVEL;
	setLogLevel(level === 'debug' || level === 'info' || level === 'error' ? level : 'warn');
}

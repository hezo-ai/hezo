import { createServer } from 'node:net';

/**
 * Outcome of probing whether the configured server port can be bound.
 * `available` is the gate; `code` carries the failing bind's errno (e.g.
 * `EADDRINUSE`, `EACCES`) so the caller can react only to "already in use"
 * and let Bun surface anything else with its own native error.
 */
export interface PortProbeResult {
	available: boolean;
	code?: string;
}

/**
 * Probe whether `port` can be bound on `host` by opening — and immediately
 * closing — a throwaway listener. `Bun.serve` binds `0.0.0.0` by default, so we
 * probe the same wildcard address: a process already listening there (commonly a
 * Hezo server the operator forgot was running) makes the bind fail with
 * `EADDRINUSE`, which we report as unavailable.
 *
 * This is a best-effort preflight, not a lock — there is an unavoidable gap
 * between the probe closing its socket and Bun binding for real. In the
 * single-operator local scenario this targets, nothing races for the port in
 * that gap; the payoff is turning Bun's bare `EADDRINUSE` crash into actionable
 * guidance. `node:net` (rather than `Bun.serve`) keeps the helper runnable and
 * testable under Node/vitest.
 */
export function probePort(port: number, host = '0.0.0.0'): Promise<PortProbeResult> {
	return new Promise((resolve) => {
		const tester = createServer();
		tester.once('error', (err: NodeJS.ErrnoException) => {
			resolve({ available: false, code: err.code });
		});
		tester.once('listening', () => {
			tester.close(() => resolve({ available: true }));
		});
		tester.listen(port, host);
	});
}

/**
 * Operator-actionable guidance when the configured port is already taken,
 * printed to the log right before the server exits. Mirrors the Docker
 * preflight: a one-line diagnosis, then the exact remedy — pick another port via
 * the `--port` flag or the `HEZO_PORT` env var (the two paths `parseConfig`
 * already supports).
 */
export function formatPortInUseMessage(port: number): string {
	return [
		`Port ${port} is already in use — another process (often a Hezo server you already started) is listening on it.`,
		'',
		'Free that port, or start Hezo on a different one:',
		'',
		`  hezo --port <port>        e.g. hezo --port ${port + 1}`,
		'  HEZO_PORT=<port> hezo',
	].join('\n');
}

import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	buildAnyPortListeningScript,
	buildKillTunnelClientsScript,
	buildPortsListeningScript,
} from '../src/services/sandbox/proc-scripts';

/**
 * These run the scripts for real against this machine's `/proc` rather than
 * asserting on their text.
 *
 * A string assertion would have passed on the version of the kill script that
 * greps the whole cmdline - which SIGKILLs the shell running it, because that
 * shell's own `-c` argument *contains* the pattern. The hazard only shows up
 * when the script actually runs, so that is what these do.
 *
 * **Linux only, and gated rather than left to fail.** The scripts read `/proc`,
 * which a macOS host does not have, and the failure is not honest: the port
 * probe's `grep` errors on the missing file and the kill loop's `/proc/[0-9]*`
 * glob matches nothing, so both degrade to silence - and every assertion here
 * that expects silence then passes while asserting nothing. Four of these six
 * did exactly that on a Mac while the other two failed, which is a worse signal
 * than not running at all.
 *
 * The version that cannot pass vacuously lives in `conformance/engine.ts`,
 * where the same scripts run inside a container - Linux on every backend, and
 * per backend, which is what proves each engine's transport carries them
 * intact. This file is the fast local echo of that on a Linux box, not the
 * coverage.
 */
const LINUX = process.platform === 'linux';
const describeOnLinux = LINUX ? describe : describe.skip;

let dir = '';
/** A stand-in for the tunnel client: argv[1] ends in `hezo-tunnel`, and it sleeps. */
let clientPath = '';

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'hezo-proc-scripts-'));
	clientPath = join(dir, 'hezo-tunnel');
	writeFileSync(clientPath, 'setTimeout(() => {}, 60_000);\n');
	chmodSync(clientPath, 0o755);
});

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Run a script the way an engine does, and resolve its stdout and exit code. */
function sh(script: string): Promise<{ stdout: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		const p = spawn('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'ignore'] });
		let stdout = '';
		p.stdout.on('data', (c: Buffer) => {
			stdout += c.toString();
		});
		p.on('error', reject);
		p.on('close', (code) => resolve({ stdout, code }));
	});
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describeOnLinux('buildKillTunnelClientsScript', () => {
	it('does not kill the shell running it', async () => {
		// The script's own text contains `hezo-tunnel`, and `sh -c <script>` puts
		// that text in the shell's cmdline. Matching argv[1] is what keeps the
		// sweep from ending itself partway through; a whole-cmdline grep here dies
		// on its first iteration and silently sweeps nothing after it.
		const { code } = await sh(`${buildKillTunnelClientsScript()}; echo done`);
		expect(code).toBe(0);
	});

	it('kills a tunnel client', async () => {
		const child = spawn('node', [clientPath, '/tmp/cfg.json'], { stdio: 'ignore' });
		const pid = child.pid as number;
		const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
		try {
			// Give the kernel a moment to publish the child's cmdline.
			await new Promise((r) => setTimeout(r, 150));
			expect(alive(pid)).toBe(true);
			await sh(buildKillTunnelClientsScript());
			await exited;
			expect(alive(pid)).toBe(false);
		} finally {
			if (alive(pid)) child.kill('SIGKILL');
		}
	});

	it('leaves a process that merely mentions the client alone', async () => {
		// Only argv[1] counts. A run whose *command* names the client - a log tail,
		// a grep, the sweep's own shell - is not the client.
		const child = spawn('node', ['-e', 'setTimeout(()=>{},60000)', clientPath], {
			stdio: 'ignore',
		});
		const pid = child.pid as number;
		try {
			await new Promise((r) => setTimeout(r, 150));
			await sh(buildKillTunnelClientsScript());
			await new Promise((r) => setTimeout(r, 150));
			expect(alive(pid)).toBe(true);
		} finally {
			child.kill('SIGKILL');
		}
	});
});

describeOnLinux('buildAnyPortListeningScript', () => {
	it('says nothing when none of the ports is listening', async () => {
		// Silence means free. Ports well above anything this machine binds.
		const { stdout } = await sh(buildAnyPortListeningScript([59991, 59992, 59993]));
		expect(stdout.trim()).toBe('');
	});

	it('says busy when one of them is taken, and is the inverse of the readiness probe', async () => {
		const { createServer } = await import('node:net');
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		const port = (server.address() as { port: number }).port;
		try {
			// One taken out of three is enough to refuse the whole triple - they are
			// handed out together, so a partial triple is no use to anyone.
			const busy = await sh(buildAnyPortListeningScript([59991, port, 59993]));
			expect(busy.stdout.trim()).toBe('busy');

			// And the readiness probe disagrees on the same set, which is the
			// relationship worth pinning: "any taken" is not "all ready".
			const ready = await sh(buildPortsListeningScript([59991, port, 59993]));
			expect(ready.stdout.trim()).toBe('');

			// The one live port on its own is both busy and ready.
			expect((await sh(buildAnyPortListeningScript([port]))).stdout.trim()).toBe('busy');
			expect((await sh(buildPortsListeningScript([port]))).stdout.trim()).toBe('ready');
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

// Ungated: rejecting a nonsensical port happens while *building* the string, so
// it never touches `/proc` and holds on every host.
describe('buildAnyPortListeningScript argument validation', () => {
	it('refuses a port that could not be a port', () => {
		expect(() => buildAnyPortListeningScript([0])).toThrow(/invalid port/);
		expect(() => buildAnyPortListeningScript([70000])).toThrow(/invalid port/);
	});
});

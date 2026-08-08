/**
 * `SandboxFiles` over a real Docker daemon.
 *
 * The Docker implementation moves bytes through the daemon's archive endpoints
 * rather than through the bind mount, which means a hand-written tar has to be
 * one the daemon actually accepts. A malformed header - most easily the checksum,
 * whose field is six octal digits, a NUL and a space rather than the seven-digit
 * shape every other numeric field uses - is rejected as corrupt, and no unit test
 * of the codec against its own reader would notice. So the codec is verified
 * here against the only reader whose opinion counts.
 *
 * Bun-native tier because `DockerClient` rides Bun's `fetch` unix-socket option,
 * which Node's undici ignores.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { DockerClient } from '../../src/services/docker';
import type { SandboxFiles } from '../../src/services/sandbox/files';

const IMAGE = 'hezo/agent-base:latest';
const ROOT = '/workspace/filetest';

const dockerAvailable = await checkDocker();
const skipReason =
	!dockerAvailable || process.env.HEZO_SKIP_DOCKER
		? 'Docker not available or HEZO_SKIP_DOCKER set'
		: (await imageExists(IMAGE))
			? null
			: `${IMAGE} not built locally`;

let containerId = '';
let files: SandboxFiles;

beforeAll(async () => {
	if (skipReason) return;
	const run = await runCommand('docker', ['run', '-d', IMAGE, 'sleep', 'infinity']);
	if (run.exitCode !== 0) throw new Error(`docker run failed: ${run.stderr.trim()}`);
	containerId = run.stdout.trim();
	await runCommand('docker', ['exec', containerId, 'mkdir', '-p', ROOT]);
	files = new DockerClient().files(containerId, ROOT);
});

afterAll(async () => {
	if (containerId) await runCommand('docker', ['rm', '-f', containerId]);
});

describe.skipIf(skipReason !== null)('SandboxFiles over real Docker', () => {
	it('writes a file the daemon accepts and reads it back byte for byte', async () => {
		// If the tar header were malformed the daemon would reject the PUT, so this
		// is really the codec's acceptance test.
		await files.write('hello.txt', 'from-hezo\n');
		expect(await files.read('hello.txt')).toBe('from-hezo\n');
	});

	it('is visible to processes in the container, not just to the API', async () => {
		await files.write('seen.txt', 'by-the-agent\n');
		const cat = await runCommand('docker', ['exec', containerId, 'cat', `${ROOT}/seen.txt`]);
		expect(cat.stdout).toContain('by-the-agent');
	});

	it('applies the mode, which is what keeps a credential from going world-readable', async () => {
		await files.write('cred', 'secret', { mode: 0o600 });
		const stat = await runCommand('docker', [
			'exec',
			containerId,
			'stat',
			'-c',
			'%a',
			`${ROOT}/cred`,
		]);
		expect(stat.stdout.trim()).toBe('600');
	});

	it('creates parent directories at the requested mode', async () => {
		// 0711 rather than 0700 is the contract: the deprivileged run user must be
		// able to traverse down to the leaf without listing what else is there.
		await files.write('nested/deep/file.txt', 'x', { dirMode: 0o711 });
		const stat = await runCommand('docker', [
			'exec',
			containerId,
			'stat',
			'-c',
			'%a',
			`${ROOT}/nested/deep`,
		]);
		expect(stat.stdout.trim()).toBe('711');
		expect(await files.read('nested/deep/file.txt')).toBe('x');
	});

	it('round-trips content larger than one tar block', async () => {
		const big = 'x'.repeat(512 * 5 + 13);
		await files.write('big.txt', big);
		expect((await files.read('big.txt')).length).toBe(big.length);
	});

	it('reports existence and removes', async () => {
		await files.write('tmp.txt', 'v');
		expect(await files.exists('tmp.txt')).toBe(true);
		await files.remove('tmp.txt');
		expect(await files.exists('tmp.txt')).toBe(false);
		// A missing file is not an error, by contract.
		await files.remove('tmp.txt');
	});

	it('finds files by name within the depth bound', async () => {
		await files.write('scan/a/wire.jsonl', '1');
		await files.write('scan/a/b/c/wire.jsonl', '2');
		const shallow = await files.findByName('scan', 'wire.jsonl', 1);
		expect(shallow).toContain('scan/a/wire.jsonl');
		expect(shallow).not.toContain('scan/a/b/c/wire.jsonl');
		const deep = await files.findByName('scan', 'wire.jsonl', 4);
		expect(deep).toContain('scan/a/b/c/wire.jsonl');
	});

	it('refuses a path that escapes the run root', async () => {
		// The rule that makes the interface switchable: a caller that can climb out
		// has silently opted into a host-shaped path.
		await expect(files.read('../../etc/passwd')).rejects.toThrow(/escapes its root/);
	});

	it('reports a missing file as an error rather than empty content', async () => {
		await expect(files.read('nope.txt')).rejects.toThrow(/not found/);
	});
});

function runCommand(
	cmd: string,
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on('data', (c: Buffer) => out.push(c));
		child.stderr.on('data', (c: Buffer) => err.push(c));
		child.on('close', (code) =>
			resolve({
				exitCode: code ?? -1,
				stdout: Buffer.concat(out).toString(),
				stderr: Buffer.concat(err).toString(),
			}),
		);
	});
}

async function checkDocker(): Promise<boolean> {
	try {
		return (
			(await runCommand('docker', ['version', '--format', '{{.Server.Version}}'])).exitCode === 0
		);
	} catch {
		return false;
	}
}

async function imageExists(image: string): Promise<boolean> {
	return (await runCommand('docker', ['image', 'inspect', image])).exitCode === 0;
}

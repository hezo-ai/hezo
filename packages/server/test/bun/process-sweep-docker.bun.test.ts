/**
 * Real-Docker integration test for the dangling-process primitives: the
 * `/proc` scan (`listHezoProcesses`), pid-list kill (`killPids`), and marker
 * kill (`killProcessesByEnvMarker`) run against a live container, because the
 * scan script's shell plumbing (environ parsing, stat-field age math, cmdline
 * matching) can only regress for real on a real runtime.
 *
 * Bun-native tier: `DockerClient.request` rides Bun's `fetch` unix-socket
 * option, which Node's undici ignores (a vitest run would dial localhost:80
 * instead of the docker socket) — so this must run under `bun test`, the
 * production runtime, like docker-stream.bun.test.ts.
 *
 * Skipped automatically when Docker is unavailable, HEZO_SKIP_DOCKER is set,
 * or the agent-base image isn't built locally — same gating as
 * ssh-agent-docker.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { type ContainerProcessInfo, DockerClient } from '../../src/services/docker';

const dockerAvailable = await checkDocker();
const skipReason =
	!dockerAvailable || process.env.HEZO_SKIP_DOCKER
		? 'Docker not available or HEZO_SKIP_DOCKER set'
		: null;

const IMAGE = 'hezo/agent-base:latest';
const imageReady = skipReason ? false : await imageExists(IMAGE);
const finalSkipReason =
	skipReason ??
	(imageReady
		? null
		: `${IMAGE} not built locally — run \`docker build -t ${IMAGE} -f docker/Dockerfile.agent-base docker\``);

let containerId: string;
let docker: DockerClient;

beforeAll(async () => {
	if (finalSkipReason) return;
	const run = await runCommand('docker', ['run', '-d', IMAGE, 'sleep', 'infinity']);
	expect(run.exitCode).toBe(0);
	containerId = run.stdout.trim();
	docker = new DockerClient();
});

afterAll(async () => {
	if (finalSkipReason || !containerId) return;
	await runCommand('docker', ['rm', '-f', containerId]);
});

async function startMarked(env: Record<string, string>): Promise<void> {
	const args = ['exec', '-d'];
	for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
	args.push(containerId, 'sleep', '300');
	const res = await runCommand('docker', args);
	expect(res.exitCode).toBe(0);
}

async function pollScan(
	predicate: (procs: ContainerProcessInfo[]) => boolean,
	timeoutMs = 30_000,
): Promise<ContainerProcessInfo[]> {
	const start = Date.now();
	let procs: ContainerProcessInfo[] = [];
	while (Date.now() - start < timeoutMs) {
		procs = await docker.listHezoProcesses(containerId);
		if (predicate(procs)) return procs;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`scan predicate not met; last scan: ${JSON.stringify(procs)}`);
}

describe.skipIf(finalSkipReason !== null)(
	'dangling-process primitives — Docker integration',
	() => {
		it('scans marked and bridge-socket processes with sane ages, then reaps by pid', async () => {
			const runId = randomUUID();
			await startMarked({ HEZO_HEARTBEAT_RUN_ID: runId });
			await startMarked({ SSH_AUTH_SOCK: '/run/hezo/legacy.sock' });

			const procs = await pollScan(
				(p) => p.some((x) => x.runId === runId) && p.some((x) => x.runId === null && x.hasHezoSock),
			);

			const marked = procs.find((p) => p.runId === runId);
			const legacy = procs.find((p) => p.runId === null && p.hasHezoSock);
			expect(marked).toBeDefined();
			expect(legacy).toBeDefined();
			if (!marked || !legacy) throw new Error('unreachable');
			expect(marked.cmdline).toContain('sleep');
			expect(marked.ageSecs).toBeGreaterThanOrEqual(0);
			expect(marked.ageSecs).toBeLessThan(120);
			expect(marked.pid).toBeGreaterThan(1);

			await docker.killPids(containerId, [marked.pid, legacy.pid]);
			await pollScan(
				(p) => !p.some((x) => x.pid === marked.pid) && !p.some((x) => x.pid === legacy.pid),
			);
		}, 90_000);

		it('killProcessesByEnvMarker kills only the matching scope', async () => {
			const doomed = randomUUID();
			const survivor = randomUUID();
			await startMarked({ HEZO_HEARTBEAT_RUN_ID: doomed });
			await startMarked({ HEZO_HEARTBEAT_RUN_ID: survivor });
			await pollScan(
				(p) => p.some((x) => x.runId === doomed) && p.some((x) => x.runId === survivor),
			);

			await docker.killProcessesByEnvMarker(containerId, 'HEZO_HEARTBEAT_RUN_ID', doomed);

			const procs = await pollScan((p) => !p.some((x) => x.runId === doomed));
			expect(procs.some((p) => p.runId === survivor)).toBe(true);
		}, 90_000);
	},
);

async function runCommand(
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
		const result = await runCommand('docker', ['version', '--format', '{{.Server.Version}}']);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

async function imageExists(image: string): Promise<boolean> {
	const result = await runCommand('docker', ['image', 'inspect', image]);
	return result.exitCode === 0;
}

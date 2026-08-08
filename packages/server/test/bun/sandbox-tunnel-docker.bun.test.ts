/**
 * The tunnel, end to end, over a real Docker hijacked exec.
 *
 * Everything else covering the tunnel drives the multiplexer over a pipe or
 * against a fake engine. That proves the framing and the in-container client,
 * but it never runs `DockerClient.openExecChannel` - and therefore never runs
 * `hijackExec`, the one piece written from Docker's API documentation rather
 * than from something observed. A hijacked exec is a raw bidirectional socket
 * carrying Docker's 8-byte stream framing; getting the upgrade, the framing or
 * the half-close wrong all look identical from a unit test, namely a stream that
 * simply never delivers.
 *
 * So this runs the real `hezo-tunnel` in the real image over a real hijacked
 * exec and asserts that a request made *inside* the container arrives at a
 * server on the host - the entire point of the tunnel, and the one claim no
 * other test can make.
 *
 * Bun-native tier for the same reason as the other Docker suites here:
 * `DockerClient.request` rides Bun's `fetch` unix-socket option, which Node's
 * undici ignores, so a vitest run dials localhost:80 instead of the daemon and
 * every assertion would vacuously skip.
 *
 * **Opt-in via `HEZO_DOCKER_TUNNEL_TEST=1`, like the Daytona live suite.** It
 * needs a daemon it can bind a host directory into and attach a hijacked exec
 * against, and it proved environment-sensitive on the shared CI runners in a way
 * it is not on a real host - so it runs as a deliberate pre-ship gate rather than
 * on every push:
 *
 *   HEZO_DOCKER_TUNNEL_TEST=1 bun test test/bun/sandbox-tunnel-docker.bun.test.ts
 *
 * Run it before shipping any change to `hijackExec`, `openExecChannel`, the
 * tunnel protocol or `hezo-tunnel` - it is the only thing that exercises the real
 * transport, and it is what caught both hijack bugs in the first place.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerClient } from '../../src/services/docker';
import { hostSandboxFiles } from '../../src/services/sandbox/files';
import { type RunTunnel, startRunTunnel } from '../../src/services/sandbox/tunnel/run-tunnel';

const IMAGE = 'hezo/agent-base:latest';

const optedIn = process.env.HEZO_DOCKER_TUNNEL_TEST === '1';
const dockerAvailable = optedIn ? await checkDocker() : false;
const skipReason = !optedIn
	? 'set HEZO_DOCKER_TUNNEL_TEST=1 to run the real-Docker tunnel gate'
	: !dockerAvailable || process.env.HEZO_SKIP_DOCKER
		? 'Docker not available or HEZO_SKIP_DOCKER set'
		: null;
const imageReady = skipReason ? false : await imageExists(IMAGE);
const finalSkipReason =
	skipReason ??
	(imageReady
		? null
		: `${IMAGE} not built locally — run \`docker build -t ${IMAGE} -f docker/Dockerfile.agent-base docker\``);

let containerId = '';
let workspace = '';
let docker: DockerClient;
let upstream: Server;
let upstreamPort = 0;
let mcpPort = 0;
let tunnel: RunTunnel | null = null;
const hits: string[] = [];

beforeAll(async () => {
	if (finalSkipReason) return;
	workspace = mkdtempSync(join(tmpdir(), 'hezo-tunnel-docker-'));

	// Stands in for the Hezo host: anything the container reaches through the
	// tunnel lands here, which is what proves bytes crossed the channel.
	upstream = createServer((req, res) => {
		hits.push(req.url ?? '');
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('reached-the-host\n');
	});
	await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
	upstreamPort = (upstream.address() as AddressInfo).port;

	const run = await runCommand('docker', [
		'run',
		'-d',
		'-v',
		`${workspace}:/workspace`,
		IMAGE,
		'sleep',
		'infinity',
	]);
	// Name the daemon's own complaint: a bare `expect(exitCode).toBe(0)` reports
	// "expected 1 to be 0", which says nothing about why the container refused.
	if (run.exitCode !== 0) {
		throw new Error(
			`docker run failed (${run.exitCode}): ${run.stderr.trim() || run.stdout.trim()}`,
		);
	}
	containerId = run.stdout.trim();
	docker = new DockerClient();
	// The bind mount is root-owned by default; the tunnel client runs as the
	// agent's own user and reads its config from there.
	await runCommand('docker', ['exec', containerId, 'chown', '-R', 'node:node', '/workspace']);
});

afterAll(async () => {
	if (finalSkipReason) return;
	tunnel?.close();
	// Empty the bind mount from *inside* the container first. Its contents are
	// written by container processes and can end up owned by a uid the test
	// process is not, which a host-side recursive delete cannot always unlink -
	// on a CI runner it surfaced as an EFAULT out of `rmSync`. Docker owns those
	// files, so let Docker remove them.
	if (containerId) {
		await runCommand('docker', ['exec', containerId, 'sh', '-c', 'rm -rf /workspace/.hezo']);
		await runCommand('docker', ['rm', '-f', containerId]);
	}
	if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
	// Best-effort: a leftover temp dir is worth far less than a red suite.
	if (workspace) {
		try {
			rmSync(workspace, { recursive: true, force: true });
		} catch {
			// Reclaimed by the runner; nothing here outlives the job.
		}
	}
});

/** curl a tunnel loopback port from inside the container. */
async function curlInContainer(port: number, path: string): Promise<string> {
	const res = await runCommand('docker', [
		'exec',
		'-u',
		'node',
		containerId,
		'sh',
		'-c',
		`curl -sS --max-time 5 http://127.0.0.1:${port}${path} || true`,
	]);
	return res.stdout + res.stderr;
}

describe.skipIf(finalSkipReason !== null)('tunnel over a real Docker hijacked exec', () => {
	it('carries a request from inside the container to a server on the host', async () => {
		tunnel = await startRunTunnel({
			engine: docker,
			containerId,
			runUser: { name: 'node', uid: 1000, gid: 1000 },
			files: hostSandboxFiles(workspace),
			configRelPath: '.hezo/tunnel.json',
			configContainerPath: '/workspace/.hezo/tunnel.json',
			// All three targets point at the same host server: the claim under test
			// is that bytes arrive, not which service answers.
			addresses: {
				proxy: { host: '127.0.0.1', port: upstreamPort },
				mcp: { host: '127.0.0.1', port: upstreamPort },
				ssh: { host: '127.0.0.1', port: upstreamPort },
			},
			policy: { proxiedHosts: [], proxyEverything: false },
		});
		// The ports are allocated per tunnel, so read the one this tunnel got
		// rather than assuming a fixed value.
		mcpPort = Number(new URL(tunnel.endpoints.hezoBaseUrl).port);

		// The client binds its listeners after the exec starts; poll rather than
		// guessing a fixed delay.
		let body = '';
		for (let attempt = 0; attempt < 40 && !body.includes('reached-the-host'); attempt++) {
			body = await curlInContainer(mcpPort, '/from-container');
			if (!body.includes('reached-the-host')) await new Promise((r) => setTimeout(r, 500));
		}

		expect(body).toContain('reached-the-host');
		expect(hits).toContain('/from-container');
	}, 180_000);

	it('reports loopback endpoints, so nothing in the run needs a host address', () => {
		// The whole reason the tunnel exists: the container never learns a host
		// name, and Hezo needs no inbound reachability.
		expect(tunnel?.endpoints.hezoBaseUrl).toContain('127.0.0.1');
		expect(tunnel?.endpoints.sshHost).toBe('127.0.0.1');
	});

	it('tears the channel down, so the container can go idle', async () => {
		// A live channel counts as activity on every backend, so a tunnel left open
		// keeps a container from ever suspending - which fails as a bill rather
		// than an error, with nothing to surface it.
		tunnel?.close();
		tunnel?.close(); // idempotent
		tunnel = null;

		const body = await curlInContainer(mcpPort, '/after-close');
		expect(body).not.toContain('reached-the-host');
	}, 60_000);
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

/**
 * Full Docker integration test for the SSH signing server.
 *
 * Spins up a real test container, runs the in-container socat bridge and
 * exercises the agent protocol from inside the container — same wire-up
 * the production agent runtime uses. Catches regressions in the bridge
 * scripts, token auth on the host TCP listener, and the host networking
 * path that mocked tests miss.
 *
 * Skipped automatically when Docker is unavailable or HEZO_SKIP_DOCKER is
 * set, so CI without Docker still passes. Runs on both macOS dev (where
 * the socat bridge is required because Docker Desktop does not forward
 * AF_UNIX bind mounts) and Linux production (where the same bridge works
 * unchanged).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import { SshAgentServer, sshPublicKeyToBlob } from '../../services/ssh-agent/server';
import { generateCompanySSHKey } from '../../services/ssh-keys';
import { safeClose } from '../helpers';
import { createTestApp } from '../helpers/app';

const dockerAvailable = await checkDocker();
const skipReason =
	!dockerAvailable || process.env.HEZO_SKIP_DOCKER
		? 'Docker not available or HEZO_SKIP_DOCKER set'
		: null;

const BRIDGE_IMAGE = 'hezo/agent-base:latest';
const bridgeImageReady = skipReason ? false : await imageExists(BRIDGE_IMAGE);
const imageSkipReason = bridgeImageReady
	? null
	: `${BRIDGE_IMAGE} not built locally — run \`docker build -t ${BRIDGE_IMAGE} -f docker/Dockerfile.agent-base docker\``;
const finalSkipReason = skipReason ?? imageSkipReason;

let db: PGlite;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let agentId: string;
let publicKey: string;
let server: SshAgentServer;
let socketDir: string;

beforeAll(async () => {
	if (finalSkipReason) return;
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;

	const companyRes = await ctx.app.request('/api/companies', {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'SSH Docker Co' }),
	});
	companyId = (await companyRes.json()).data.id;

	const agentRes = await ctx.app.request(`/api/companies/${companyId}/agents`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'SSH Docker Agent' }),
	});
	agentId = (await agentRes.json()).data.id;

	const ssh = await generateCompanySSHKey(db, companyId, masterKeyManager);
	publicKey = ssh.publicKey;

	server = new SshAgentServer({ db, masterKeyManager });
	socketDir = mkdtempSync(join(tmpdir(), 'hezo-ssh-docker-'));
}, 30_000);

afterAll(async () => {
	if (finalSkipReason) return;
	await server.releaseAll();
	await safeClose(db);
});

describe.skipIf(finalSkipReason !== null)('SSH agent — Docker integration', () => {
	it('agent protocol over the in-container socat bridge surfaces the company key via ssh-add -L', async () => {
		const runId = `docker-run-${Date.now()}`;
		const socketHostPath = join(socketDir, `${runId}.sock`);
		const allocated = await server.allocateRunSocket(runId, { companyId, agentId }, socketHostPath);

		const containerSocketPath = `/run/hezo/${runId}.sock`;
		const result = await runInContainer({
			image: BRIDGE_IMAGE,
			env: { SSH_AUTH_SOCK: containerSocketPath },
			extraHosts: ['host.docker.internal:host-gateway'],
			command: [
				'/usr/local/bin/hezo-run-with-bridge',
				containerSocketPath,
				'root',
				allocated.tokenHex,
				`host.docker.internal:${allocated.tcpHostPort}`,
				'--',
				'sh',
				'-c',
				'ssh-add -L',
			],
			timeoutMs: 60_000,
		});

		await server.releaseRunSocket(runId);

		expect(result.exitCode).toBe(0);
		const stdoutKey = result.stdout.trim();
		expect(stdoutKey).toContain('ssh-ed25519');
		const advertisedBlob = sshPublicKeyToBlob(stdoutKey);
		const expectedBlob = sshPublicKeyToBlob(publicKey);
		expect(advertisedBlob).toEqual(expectedBlob);
		expect(stdoutKey).toContain(`hezo:${companyId}`);
	}, 90_000);

	it('container has no private key file in the SSH config or temp dirs after the run', async () => {
		const runId = `docker-leak-${Date.now()}`;
		const socketHostPath = join(socketDir, `${runId}.sock`);
		const allocated = await server.allocateRunSocket(runId, { companyId, agentId }, socketHostPath);

		const containerSocketPath = `/run/hezo/${runId}.sock`;
		const result = await runInContainer({
			image: BRIDGE_IMAGE,
			env: { SSH_AUTH_SOCK: containerSocketPath },
			extraHosts: ['host.docker.internal:host-gateway'],
			command: [
				'/usr/local/bin/hezo-run-with-bridge',
				containerSocketPath,
				'root',
				allocated.tokenHex,
				`host.docker.internal:${allocated.tcpHostPort}`,
				'--',
				'sh',
				'-c',
				'ssh-add -L > /dev/null 2>&1; ' +
					'find / -path "/proc" -prune -o \\( -name "id_ed25519" -o -name "id_ed25519.pub" \\) -print 2>/dev/null; true',
			],
			timeoutMs: 60_000,
		});

		await server.releaseRunSocket(runId);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe('');
	}, 90_000);

	it('signs ssh-keygen -Y sign challenges from inside the container and verifies on the host', async () => {
		const runId = `docker-sign-${Date.now()}`;
		const socketHostPath = join(socketDir, `${runId}.sock`);
		const allocated = await server.allocateRunSocket(runId, { companyId, agentId }, socketHostPath);

		const containerSocketPath = `/run/hezo/${runId}.sock`;
		const containerPubFile = '/tmp/key.pub';
		const containerDataFile = '/tmp/payload';
		const result = await runInContainer({
			image: BRIDGE_IMAGE,
			env: { SSH_AUTH_SOCK: containerSocketPath },
			extraHosts: ['host.docker.internal:host-gateway'],
			command: [
				'/usr/local/bin/hezo-run-with-bridge',
				containerSocketPath,
				'root',
				allocated.tokenHex,
				`host.docker.internal:${allocated.tcpHostPort}`,
				'--',
				'sh',
				'-c',
				[
					`echo "${publicKey}" > ${containerPubFile}`,
					`echo "verify-payload" > ${containerDataFile}`,
					`ssh-keygen -Y sign -f ${containerPubFile} -n git ${containerDataFile} > /dev/null 2>&1`,
					`cat ${containerDataFile}.sig`,
				].join(' && '),
			],
			timeoutMs: 90_000,
		});

		await server.releaseRunSocket(runId);

		expect(result.exitCode).toBe(0);
		const sigPem = result.stdout;
		expect(sigPem).toContain('-----BEGIN SSH SIGNATURE-----');

		const sigPath = join(socketDir, `${runId}.sig`);
		const dataPath = join(socketDir, `${runId}.data`);
		const signersPath = join(socketDir, `${runId}.signers`);
		writeFileSync(sigPath, sigPem);
		writeFileSync(dataPath, 'verify-payload\n');
		const signerLine = `agent-${companyId}@hezo.local ${publicKey.split(/\s+/).slice(0, 2).join(' ')}`;
		writeFileSync(signersPath, `${signerLine}\n`);

		const verify = await runCommand(
			'ssh-keygen',
			[
				'-Y',
				'verify',
				'-f',
				signersPath,
				'-I',
				`agent-${companyId}@hezo.local`,
				'-n',
				'git',
				'-s',
				sigPath,
			],
			{},
			Buffer.from('verify-payload\n'),
		);
		expect(verify.code).toBe(0);
	}, 120_000);
});

interface RunInContainerArgs {
	image: string;
	env: Record<string, string>;
	command: string[];
	timeoutMs: number;
	extraHosts?: string[];
}

async function runInContainer(
	args: RunInContainerArgs,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const dockerArgs = ['run', '--rm', '-i'];
	for (const host of args.extraHosts ?? []) {
		dockerArgs.push('--add-host', host);
	}
	for (const [k, v] of Object.entries(args.env)) {
		dockerArgs.push('-e', `${k}=${v}`);
	}
	dockerArgs.push(args.image, ...args.command);
	return await runCommand('docker', dockerArgs, {}, undefined, args.timeoutMs);
}

async function runCommand(
	cmd: string,
	args: string[],
	env: Record<string, string>,
	stdin?: Buffer,
	timeoutMs?: number,
): Promise<{ code: number; exitCode: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			env: { ...process.env, ...env },
			stdio: stdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
		child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));
		const timer = timeoutMs
			? setTimeout(() => {
					child.kill('SIGKILL');
				}, timeoutMs)
			: null;
		if (stdin) child.stdin?.end(stdin);
		child.on('close', (code) => {
			if (timer) clearTimeout(timer);
			const exitCode = code ?? -1;
			resolve({
				code: exitCode,
				exitCode,
				stdout: Buffer.concat(stdoutChunks).toString(),
				stderr: Buffer.concat(stderrChunks).toString(),
			});
		});
	});
}

async function checkDocker(): Promise<boolean> {
	try {
		const result = await runCommand('docker', ['version', '--format', '{{.Server.Version}}'], {});
		return result.code === 0;
	} catch {
		return false;
	}
}

async function imageExists(image: string): Promise<boolean> {
	const result = await runCommand('docker', ['image', 'inspect', image], {});
	return result.code === 0;
}

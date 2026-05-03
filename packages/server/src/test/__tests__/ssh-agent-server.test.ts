import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import {
	FrameReader,
	MSG_IDENTITIES_ANSWER,
	MSG_REQUEST_IDENTITIES,
	MSG_SIGN_REQUEST,
	MSG_SIGN_RESPONSE,
} from '../../services/ssh-agent/protocol';
import { SshAgentServer, sshPublicKeyToBlob } from '../../services/ssh-agent/server';
import { generateCompanySSHKey } from '../../services/ssh-keys';
import { safeClose } from '../helpers';
import { createTestApp } from '../helpers/app';

let db: PGlite;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let agentId: string;
let publicKey: string;
let server: SshAgentServer;
let socketDir: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;

	const companyRes = await ctx.app.request('/api/companies', {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'SSH Test Co' }),
	});
	companyId = (await companyRes.json()).data.id;

	const agentRes = await ctx.app.request(`/api/companies/${companyId}/agents`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'SSH Agent' }),
	});
	agentId = (await agentRes.json()).data.id;

	const ssh = await generateCompanySSHKey(db, companyId, masterKeyManager);
	publicKey = ssh.publicKey;

	server = new SshAgentServer({ db, masterKeyManager });
	socketDir = mkdtempSync(join(tmpdir(), 'hezo-ssh-agent-'));
});

afterAll(async () => {
	await server.releaseAll();
	await safeClose(db);
});

describe('SshAgentServer integration', () => {
	it('advertises the company key via REQUEST_IDENTITIES', async () => {
		const runId = 'run-identities';
		const socketPath = join(socketDir, `${runId}.sock`);
		await server.allocateRunSocket(runId, { companyId, agentId }, socketPath);

		const reply = await sendAndReceive(socketPath, frame(Buffer.from([MSG_REQUEST_IDENTITIES])));
		expect(reply[0]).toBe(MSG_IDENTITIES_ANSWER);
		const nkeys = reply.readUInt32BE(1);
		expect(nkeys).toBe(1);
		const keyLen = reply.readUInt32BE(5);
		const keyBlob = reply.subarray(9, 9 + keyLen);
		const expected = sshPublicKeyToBlob(publicKey);
		expect(keyBlob).toEqual(expected);

		await server.releaseRunSocket(runId);
	});

	it('signs data with the company key and returns ssh-ed25519 signature', async () => {
		const runId = 'run-sign-protocol';
		const socketPath = join(socketDir, `${runId}.sock`);
		await server.allocateRunSocket(runId, { companyId, agentId }, socketPath);

		const keyBlob = sshPublicKeyToBlob(publicKey);
		const data = Buffer.from('verify-me');
		const payload = Buffer.concat([
			Buffer.from([MSG_SIGN_REQUEST]),
			lenPrefixed(keyBlob),
			lenPrefixed(data),
			uint32(0),
		]);
		const reply = await sendAndReceive(socketPath, frame(payload));
		expect(reply[0]).toBe(MSG_SIGN_RESPONSE);
		const sigBlobLen = reply.readUInt32BE(1);
		const sigBlob = reply.subarray(5, 5 + sigBlobLen);
		const algoLen = sigBlob.readUInt32BE(0);
		expect(sigBlob.subarray(4, 4 + algoLen).toString()).toBe('ssh-ed25519');
		const sigLen = sigBlob.readUInt32BE(4 + algoLen);
		expect(sigLen).toBe(64);

		await server.releaseRunSocket(runId);
	});

	it('signs through ssh-keygen -Y sign and is verifiable', async () => {
		if (!(await hasCommand('ssh-keygen'))) return;
		const runId = 'run-keygen-sign';
		const socketPath = join(socketDir, `${runId}.sock`);
		await server.allocateRunSocket(runId, { companyId, agentId }, socketPath);

		const pubFile = join(socketDir, `${runId}.pub`);
		writeFileSync(pubFile, `${publicKey}\n`);
		const dataFile = join(socketDir, `${runId}.data`);
		writeFileSync(dataFile, 'message-to-sign');
		const sigFile = `${dataFile}.sig`;

		const signOut = await runCommand(
			'ssh-keygen',
			['-Y', 'sign', '-f', pubFile, '-n', 'git', dataFile],
			{ SSH_AUTH_SOCK: socketPath },
		);
		expect(signOut.code).toBe(0);

		const allowedSigners = `agent-${companyId}@hezo.local ${publicKey.split(/\s+/).slice(0, 2).join(' ')}`;
		const signersFile = join(socketDir, `${runId}.signers`);
		writeFileSync(signersFile, `${allowedSigners}\n`);

		const verifyOut = await runCommand(
			'ssh-keygen',
			[
				'-Y',
				'verify',
				'-f',
				signersFile,
				'-I',
				`agent-${companyId}@hezo.local`,
				'-n',
				'git',
				'-s',
				sigFile,
			],
			{},
			readFileSync(dataFile),
		);
		expect(verifyOut.code).toBe(0);

		await server.releaseRunSocket(runId);
	}, 15_000);
});

function frame(payload: Buffer): Buffer {
	const out = Buffer.alloc(4 + payload.length);
	out.writeUInt32BE(payload.length, 0);
	payload.copy(out, 4);
	return out;
}

function lenPrefixed(buf: Buffer): Buffer {
	const out = Buffer.alloc(4 + buf.length);
	out.writeUInt32BE(buf.length, 0);
	buf.copy(out, 4);
	return out;
}

function uint32(value: number): Buffer {
	const out = Buffer.alloc(4);
	out.writeUInt32BE(value, 0);
	return out;
}

async function sendAndReceive(socketPath: string, framed: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const reader = new FrameReader();
		const sock = connect(socketPath);
		sock.on('connect', () => sock.write(framed));
		sock.on('data', (chunk) => {
			reader.push(chunk);
			const next = reader.next();
			if (next) {
				sock.end();
				resolve(next);
			}
		});
		sock.on('error', reject);
	});
}

async function runCommand(
	cmd: string,
	args: string[],
	env: Record<string, string>,
	stdin?: Buffer,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			env: { ...process.env, ...env },
			stdio: stdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
		child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));
		if (stdin) {
			child.stdin?.end(stdin);
		}
		child.on('close', (code) => {
			resolve({
				code: code ?? -1,
				stdout: Buffer.concat(stdoutChunks).toString(),
				stderr: Buffer.concat(stderrChunks).toString(),
			});
		});
	});
}

async function hasCommand(cmd: string): Promise<boolean> {
	const result = await runCommand(cmd, ['-h'], {});
	return result.code !== -1;
}

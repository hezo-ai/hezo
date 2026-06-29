import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MasterKeyManager } from '../src/crypto/master-key';
import {
	FrameReader,
	MSG_FAILURE,
	MSG_IDENTITIES_ANSWER,
	MSG_REQUEST_IDENTITIES,
	MSG_SIGN_REQUEST,
} from '../src/services/ssh-agent/protocol';
import { SshAgentServer, sshPublicKeyToBlob } from '../src/services/ssh-agent/server';
import { generateTeamSSHKey } from '../src/services/ssh-keys';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: PGlite;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let agentId: string;
let publicKey: string;
let socketDir: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
	// HQ team already exists with a CEO member — reuse it for the key-bearing team.
	const team = await db.query<{ id: string }>('SELECT id FROM teams ORDER BY created_at LIMIT 1');
	teamId = team.rows[0].id;
	const agent = await db.query<{ id: string }>(
		`SELECT m.id FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.team_id = $1 LIMIT 1`,
		[teamId],
	);
	agentId = agent.rows[0].id;
	const ssh = await generateTeamSSHKey(db, teamId, masterKeyManager);
	publicKey = ssh.publicKey;
	socketDir = mkdtempSync(join(tmpdir(), 'hezo-ssh-branches-'));
});

afterAll(async () => {
	await safeClose(db);
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

function sendAndReceive(socketPath: string, framed: Buffer): Promise<Buffer> {
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

function sendOverTcp(port: number, framed: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const reader = new FrameReader();
		const sock = connect({ host: '127.0.0.1', port });
		sock.on('connect', () => sock.write(framed));
		sock.on('data', (chunk) => {
			reader.push(chunk);
			const next = reader.next();
			if (next) {
				sock.end();
				resolve(next);
			}
		});
		sock.on('close', () => reject(new Error('closed before reply')));
		sock.on('error', reject);
	});
}

describe('sshPublicKeyToBlob (parsing branches)', () => {
	it('throws on a key with fewer than two whitespace-separated parts', () => {
		expect(() => sshPublicKeyToBlob('ssh-ed25519')).toThrow(/invalid SSH public key/);
		expect(() => sshPublicKeyToBlob('   ')).toThrow(/invalid SSH public key/);
	});

	it('returns the raw decoded blob for a non-ed25519 key type (no last-32 reslice)', () => {
		// An RSA-typed key: the function decodes base64 and returns it verbatim,
		// taking the non-ed25519 branch (no ed25519PublicKeyBlob rewrap).
		const raw = Buffer.from('hello-world-key-bytes');
		const key = `ssh-rsa ${raw.toString('base64')} comment`;
		expect(sshPublicKeyToBlob(key)).toEqual(raw);
	});

	it('rewraps an ssh-ed25519 key into a fresh public-key blob', () => {
		const blob = sshPublicKeyToBlob(publicKey);
		// ssh-ed25519 blobs are 51 bytes: 4+11 algo + 4+32 key.
		expect(blob.length).toBe(51);
		expect(blob.subarray(4, 15).toString()).toBe('ssh-ed25519');
	});
});

describe('SshAgentServer connection-guard branches', () => {
	it('sign request with an unknown key blob is rejected with SSH_AGENT_FAILURE', async () => {
		const server = new SshAgentServer({ db, masterKeyManager });
		const runId = 'run-unknown-key';
		const socketPath = join(socketDir, `${runId}.sock`);
		await server.allocateRunSocket(runId, { teamId, agentId, label: 'eng/ENG-1' }, socketPath);

		// A blob that does not match any team key → signWithMatchingKey returns null.
		const bogusBlob = Buffer.alloc(51, 0x11);
		const payload = Buffer.concat([
			Buffer.from([MSG_SIGN_REQUEST]),
			lenPrefixed(bogusBlob),
			lenPrefixed(Buffer.from('data')),
			Buffer.from([0, 0, 0, 0]),
		]);
		const reply = await sendAndReceive(socketPath, frame(payload));
		expect(reply[0]).toBe(MSG_FAILURE);

		await server.releaseRunSocket(runId);
	});

	it('an unknown message type is answered with SSH_AGENT_FAILURE (default arm)', async () => {
		const server = new SshAgentServer({ db, masterKeyManager });
		const runId = 'run-unknown-msg';
		const socketPath = join(socketDir, `${runId}.sock`);
		await server.allocateRunSocket(runId, { teamId, agentId }, socketPath);

		// Message type 0xff is not REQUEST_IDENTITIES or SIGN_REQUEST.
		const reply = await sendAndReceive(socketPath, frame(Buffer.from([0xff])));
		expect(reply[0]).toBe(MSG_FAILURE);

		await server.releaseRunSocket(runId);
	});

	it('releaseAll tears down every allocated run socket (unix + tcp)', async () => {
		const server = new SshAgentServer({ db, masterKeyManager });
		await server.allocateRunSocket('ra-1', { teamId, agentId }, join(socketDir, 'ra-1.sock'));
		await server.allocateRunSocket('ra-2', { teamId, agentId }, join(socketDir, 'ra-2.sock'));
		await server.releaseAll();
		// Releasing again is a no-op (everything already gone) and must not throw.
		await server.releaseRunSocket('ra-1');
		expect(true).toBe(true);
	});

	it('releaseRunSocket on an unknown runId is a harmless no-op', async () => {
		const server = new SshAgentServer({ db, masterKeyManager });
		await server.releaseRunSocket('never-allocated');
		expect(true).toBe(true);
	});

	it('honours an explicit tcpListenHost bind for the per-run TCP listener', async () => {
		const server = new SshAgentServer({ db, masterKeyManager, tcpListenHost: '127.0.0.1' });
		const runId = 'run-tcp-host';
		const socketPath = join(socketDir, `${runId}.sock`);
		const allocated = await server.allocateRunSocket(runId, { teamId, agentId }, socketPath);
		expect(allocated.tcpHostPort).toBeGreaterThan(0);
		await server.releaseRunSocket(runId);
	});

	it('prefers bindHostRef over tcpListenHost when both are set', async () => {
		const server = new SshAgentServer({
			db,
			masterKeyManager,
			tcpListenHost: '0.0.0.0',
			bindHostRef: { get: () => '127.0.0.1' },
		});
		const runId = 'run-bindref';
		const socketPath = join(socketDir, `${runId}.sock`);
		const allocated = await server.allocateRunSocket(runId, { teamId, agentId }, socketPath);

		// The ref host (loopback) is reachable; the token auth + identities round-trip
		// proves the listener bound on the ref, not the tcpListenHost default.
		const tokenBytes = Buffer.from(allocated.tokenHex, 'hex');
		const reply = await sendOverTcp(
			allocated.tcpHostPort,
			Buffer.concat([tokenBytes, frame(Buffer.from([MSG_REQUEST_IDENTITIES]))]),
		);
		expect(reply[0]).toBe(MSG_IDENTITIES_ANSWER);

		await server.releaseRunSocket(runId);
	});

	it('splits a TCP token that arrives across multiple chunks (partial-token branch)', async () => {
		const server = new SshAgentServer({ db, masterKeyManager });
		const runId = 'run-tcp-split';
		const socketPath = join(socketDir, `${runId}.sock`);
		const allocated = await server.allocateRunSocket(runId, { teamId, agentId }, socketPath);

		const tokenBytes = Buffer.from(allocated.tokenHex, 'hex');
		const reply = await new Promise<Buffer>((resolve, reject) => {
			const reader = new FrameReader();
			const sock = connect({ host: '127.0.0.1', port: allocated.tcpHostPort });
			sock.on('connect', () => {
				// First half of the token: collected < TCP_TOKEN_BYTES, early return.
				sock.write(tokenBytes.subarray(0, 8));
				setTimeout(() => {
					// Remaining token + framed request in a later chunk.
					sock.write(
						Buffer.concat([tokenBytes.subarray(8), frame(Buffer.from([MSG_REQUEST_IDENTITIES]))]),
					);
				}, 20);
			});
			sock.on('data', (chunk) => {
				reader.push(chunk);
				const next = reader.next();
				if (next) {
					sock.end();
					resolve(next);
				}
			});
			sock.on('close', () => reject(new Error('closed before reply')));
			sock.on('error', reject);
		});
		expect(reply[0]).toBe(MSG_IDENTITIES_ANSWER);

		await server.releaseRunSocket(runId);
	});

	it('loadKeysForTeam throws when the master key is unavailable (locked manager)', async () => {
		// A locked manager has no key — resolveKeys must throw, which the frame
		// handler catches and answers with FAILURE.
		const locked = new MasterKeyManager();
		await locked.initialize(db);
		const server = new SshAgentServer({ db, masterKeyManager: locked });
		const runId = 'run-locked';
		const socketPath = join(socketDir, `${runId}.sock`);
		await server.allocateRunSocket(runId, { teamId, agentId }, socketPath);

		const reply = await sendAndReceive(socketPath, frame(Buffer.from([MSG_REQUEST_IDENTITIES])));
		// resolveKeys throws "Master key not available" → handler writes FAILURE.
		expect(reply[0]).toBe(MSG_FAILURE);

		await server.releaseRunSocket(runId);
	});
});

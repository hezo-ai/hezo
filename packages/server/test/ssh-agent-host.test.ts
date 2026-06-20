import { existsSync, mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import { withHostAgentSocket } from '../src/services/ssh-agent/host';
import {
	FrameReader,
	MSG_IDENTITIES_ANSWER,
	MSG_REQUEST_IDENTITIES,
} from '../src/services/ssh-agent/protocol';
import { SshAgentServer, sshPublicKeyToBlob } from '../src/services/ssh-agent/server';
import { generateTeamSSHKey } from '../src/services/ssh-keys';
import { safeClose } from './helpers';
import { createTestApp, createTestTeam } from './helpers/app';

let db: PGlite;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let publicKey: string;
let server: SshAgentServer;
let dataDir: string;

function frame(payload: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(payload.length);
	return Buffer.concat([len, payload]);
}

async function sendAndReceive(socketPath: string, payload: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const sock = connect(socketPath);
		const reader = new FrameReader();
		sock.on('error', reject);
		sock.on('data', (chunk: Buffer) => {
			reader.push(chunk);
			const next = reader.next();
			if (next) {
				sock.end();
				resolve(next);
			}
		});
		sock.write(payload);
	});
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(ctx.db, { name: 'Host Agent Co' });
	teamId = (await teamRes.json()).data.id;

	const ssh = await generateTeamSSHKey(db, teamId, masterKeyManager);
	publicKey = ssh.publicKey;

	dataDir = mkdtempSync(join(tmpdir(), 'hezo-host-agent-'));
	server = new SshAgentServer({ db, masterKeyManager });
});

afterAll(async () => {
	await server.releaseAll();
	await safeClose(db);
});

describe('withHostAgentSocket', () => {
	it('allocates a socket that advertises the team key, then releases on exit', async () => {
		let observedPath = '';
		await withHostAgentSocket(server, teamId, dataDir, async ({ sshAuthSock }) => {
			observedPath = sshAuthSock;
			expect(existsSync(sshAuthSock)).toBe(true);

			const reply = await sendAndReceive(sshAuthSock, frame(Buffer.from([MSG_REQUEST_IDENTITIES])));
			expect(reply[0]).toBe(MSG_IDENTITIES_ANSWER);
			const nkeys = reply.readUInt32BE(1);
			expect(nkeys).toBe(1);
			const keyLen = reply.readUInt32BE(5);
			const keyBlob = reply.subarray(9, 9 + keyLen);
			expect(keyBlob).toEqual(sshPublicKeyToBlob(publicKey));
		});

		expect(existsSync(observedPath)).toBe(false);
	});

	it('releases the socket even if fn throws', async () => {
		let observedPath = '';
		await expect(
			withHostAgentSocket(server, teamId, dataDir, async ({ sshAuthSock }) => {
				observedPath = sshAuthSock;
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');

		expect(existsSync(observedPath)).toBe(false);
	});
});

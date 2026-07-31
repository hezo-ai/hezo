import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { withProvisionBridge } from '../src/services/ssh-agent/host';
import {
	FrameReader,
	MSG_IDENTITIES_ANSWER,
	MSG_REQUEST_IDENTITIES,
} from '../src/services/ssh-agent/protocol';
import { SshAgentServer, sshPublicKeyToBlob } from '../src/services/ssh-agent/server';
import { generateTeamSSHKey } from '../src/services/ssh-keys';
import { safeClose } from './helpers';
import { createStubDocker, createTestApp, createTestTeam } from './helpers/app';

let db: Db;
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

/** Authenticate to the per-run TCP listener (16-byte token prefix), then ask for identities. */
async function tcpRequestIdentities(port: number, tokenHex: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const sock = connect({ host: '127.0.0.1', port });
		const reader = new FrameReader();
		sock.on('error', reject);
		sock.on('connect', () => {
			sock.write(Buffer.from(tokenHex, 'hex'));
			sock.write(frame(Buffer.from([MSG_REQUEST_IDENTITIES])));
		});
		sock.on('data', (chunk: Buffer) => {
			reader.push(chunk);
			const next = reader.next();
			if (next) {
				sock.end();
				resolve(next);
			}
		});
	});
}

/** Whether connecting to the loopback port is refused (i.e. the listener is gone). */
function connectRefused(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = connect({ host: '127.0.0.1', port });
		sock.on('error', () => resolve(true));
		sock.on('connect', () => {
			sock.destroy();
			resolve(false);
		});
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

const runUser = { name: 'node', uid: 1000, gid: 1000 } as const;

/**
 * A provisioning git op reaches the ssh-agent the same way everything else
 * reaches Hezo: through a tunnel. So the bridge it hands the container names
 * container loopback, and the host TCP port is only ever dialled by the tunnel's
 * host-side end - which is why the test has to capture it from the allocation
 * rather than read it off the bridge.
 */
function provisionTarget(capture: { hostPort: number }) {
	const engine = createStubDocker({
		openExecChannel: async () => ({
			write: () => {},
			close: () => {},
			onData: () => {},
			onStderr: () => {},
			onClose: () => {},
		}),
		files: () => ({
			exists: async () => false,
			read: async () => '',
			remove: async () => {},
			findByName: async () => [],
			write: async () => {},
			mkdir: async () => {},
			removeDir: async () => {},
		}),
	});
	const allocate = server.allocateRunSocket.bind(server);
	server.allocateRunSocket = async (...args: Parameters<typeof allocate>) => {
		const allocated = await allocate(...args);
		capture.hostPort = allocated.tcpHostPort;
		return allocated;
	};
	return { engine, containerId: 'ctr-provision', teamId, dataDir, runUser };
}

describe('withProvisionBridge', () => {
	it('allocates a bridge over the tunnel, advertising the team key, then releases on exit', async () => {
		const capture = { hostPort: 0 };
		await withProvisionBridge(server, provisionTarget(capture), async ({ bridge }) => {
			expect(bridge.tokenHex).toMatch(/^[0-9a-f]{32}$/);
			expect(bridge.socketPath.startsWith('/run/hezo/')).toBe(true);
			expect(bridge.socketUser).toBe('node');
			// Loopback, never the host: the container has no route to the host on
			// any backend, so a bridge naming one would only work locally.
			expect(bridge.hostName).toBe('127.0.0.1');
			expect(bridge.hostPort).toBeGreaterThan(0);
			expect(capture.hostPort).toBeGreaterThan(0);
			expect(bridge.hostPort).not.toBe(capture.hostPort);

			// The host listener the tunnel forwards to really does serve the key.
			const reply = await tcpRequestIdentities(capture.hostPort, bridge.tokenHex);
			expect(reply[0]).toBe(MSG_IDENTITIES_ANSWER);
			expect(reply.readUInt32BE(1)).toBe(1);
			const keyLen = reply.readUInt32BE(5);
			expect(reply.subarray(9, 9 + keyLen)).toEqual(sshPublicKeyToBlob(publicKey));
		});

		expect(await connectRefused(capture.hostPort)).toBe(true);
	});

	it('releases the bridge even if fn throws', async () => {
		const capture = { hostPort: 0 };
		await expect(
			withProvisionBridge(server, provisionTarget(capture), async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');

		expect(await connectRefused(capture.hostPort)).toBe(true);
	});
});

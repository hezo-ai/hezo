import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { loadOrCreateCA } from '../src/services/egress/ca';
import { EgressProxy } from '../src/services/egress/proxy';
import type { ProvisionBridgeTarget } from '../src/services/ssh-agent/host';
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
let egressProxy: EgressProxy;

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

	// A provisioning clone authenticates with a placeholder only the proxy can
	// substitute, so the bridge now allocates one — a real instance, because the
	// point of these tests is that the allocation happens and is released.
	egressProxy = new EgressProxy({
		db,
		masterKeyManager,
		ca: await loadOrCreateCA(join(dataDir, 'ca')),
	});

	// Gives `buildTunnelHostPolicy` something to derive, so the policy assertion
	// below is checking a real vault read rather than an empty list.
	await db.query(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ('PROVISION_TEST_TOKEN', 'x', 'api_token'::secret_category, $1)`,
		[['github.com', 'codeload.github.com']],
	);
});

afterAll(async () => {
	await egressProxy.releaseAll().catch(() => undefined);
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
interface Capture {
	hostPort: number;
	/** Host-side port of the egress allocation the tunnel's `proxy` target names. */
	proxyHostPort: number;
	/** The tunnel config written into the container, so its policy is checkable. */
	tunnelConfig: { policy?: { proxiedHosts?: string[]; proxyEverything?: boolean } };
}

function newCapture(): Capture {
	return { hostPort: 0, proxyHostPort: 0, tunnelConfig: {} };
}

function provisionTarget(capture: Capture): ProvisionBridgeTarget {
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
			// The tunnel writes `{ports, policy}` here for the in-container client;
			// capturing it is how the split-routing policy becomes observable.
			write: async (_path: string, contents: string) => {
				capture.tunnelConfig = JSON.parse(contents);
			},
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
	const allocateProxy = egressProxy.allocateRunProxy.bind(egressProxy);
	egressProxy.allocateRunProxy = async (...args: Parameters<typeof allocateProxy>) => {
		const allocated = await allocateProxy(...args);
		capture.proxyHostPort = allocated.proxyPort;
		return allocated;
	};
	return {
		engine,
		containerId: 'ctr-provision',
		teamId,
		dataDir,
		runUser,
		db,
		egressProxy,
		projectId: null,
	};
}

describe('withProvisionBridge', () => {
	it('allocates a bridge over the tunnel, advertising the team key, then releases on exit', async () => {
		const capture = newCapture();
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

	/**
	 * The regression this whole path exists for. Git transport moved from SSH to
	 * HTTPS, so a provisioning clone's remote now carries
	 * `__HEZO_SECRET_<NAME>__` and only the egress proxy can turn it into a
	 * credential. The tunnel used to point its `proxy` target at port 0 with an
	 * empty policy, so every private clone connected direct and shipped the
	 * placeholder as its password — which GitHub reports as `Invalid username or
	 * token`, sending the reader after the one thing that is not wrong.
	 */
	it('routes the container at a real egress proxy, with a vault-derived policy', async () => {
		const capture = newCapture();
		await withProvisionBridge(server, provisionTarget(capture), async ({ proxyEnv }) => {
			expect(capture.proxyHostPort).toBeGreaterThan(0);

			// Split routing is derived from the vault, never hand-written, so the
			// seeded secret's `allowed_hosts` is what the container is told to proxy.
			expect(capture.tunnelConfig.policy?.proxiedHosts).toContain('github.com');
			expect(capture.tunnelConfig.policy?.proxiedHosts).toContain('codeload.github.com');
			expect(capture.tunnelConfig.policy?.proxyEverything).toBe(false);

			// Git reads these the way every other HTTP client does; without them the
			// clone never reaches the proxy at all.
			const proxyUrl = proxyEnv
				.find((e) => e.startsWith('HTTPS_PROXY='))
				?.slice('HTTPS_PROXY='.length);
			expect(proxyUrl).toBeDefined();
			// Container loopback, never the host allocation behind it — a container
			// has no route to Hezo's loopback on any backend.
			const parsed = new URL(proxyUrl as string);
			expect(parsed.hostname).toBe('127.0.0.1');
			expect(Number(parsed.port)).toBeGreaterThan(0);
			expect(Number(parsed.port)).not.toBe(capture.proxyHostPort);
			expect(parsed.username).toBe('run');
			expect(parsed.password.length).toBeGreaterThan(0);
			// Both spellings, because clients disagree about which they read.
			expect(proxyEnv).toContain(`https_proxy=${proxyUrl}`);
			expect(proxyEnv.some((e) => e.startsWith('NO_PROXY='))).toBe(true);
		});

		// Released with the bridge: a leaked per-op proxy is a bound port and a live
		// server for the life of the process.
		expect(await connectRefused(capture.proxyHostPort)).toBe(true);
	});

	it('releases the bridge and the egress proxy even if fn throws', async () => {
		const capture = newCapture();
		await expect(
			withProvisionBridge(server, provisionTarget(capture), async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');

		expect(await connectRefused(capture.hostPort)).toBe(true);
		expect(await connectRefused(capture.proxyHostPort)).toBe(true);
	});

	/**
	 * Fail closed and *named*. Standing the tunnel up without an egress
	 * allocation is what shipped: the clone still ran, reached GitHub with an
	 * unsubstituted placeholder, and failed as a credential problem.
	 */
	it('refuses to run without an egress proxy, rather than cloning uncredentialed', async () => {
		const capture = newCapture();
		const target = provisionTarget(capture);
		await expect(
			withProvisionBridge(
				server,
				{ ...target, egressProxy: undefined as unknown as EgressProxy },
				async () => 'unreachable',
			),
		).rejects.toThrow(/egress proxy/i);
	});
});

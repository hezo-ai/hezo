import { createPrivateKey, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { AddressInfo, Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { decrypt } from '../../crypto/encryption';
import type { MasterKeyManager } from '../../crypto/master-key';
import { logger } from '../../logger';
import {
	type AgentIdentity,
	decodeMessage,
	ed25519PublicKeyBlob,
	ed25519SignatureBlob,
	encodeFailure,
	encodeIdentitiesAnswer,
	encodeSignResponse,
	FrameReader,
	MSG_REQUEST_IDENTITIES,
	MSG_SIGN_REQUEST,
	type SignRequest,
} from './protocol';
import { type KeyEntry, Registry, type RunIdentity } from './registry';

const log = logger.child('ssh-agent');

const TCP_TOKEN_BYTES = 16;
const TCP_LISTEN_HOST = '127.0.0.1';

export interface SshAgentServerDeps {
	db: PGlite;
	masterKeyManager: MasterKeyManager;
}

export interface AllocatedSocket {
	socketHostPath: string;
	tcpHostPort: number;
	tokenHex: string;
}

export class SshAgentServer {
	private readonly registry = new Registry();
	private readonly listeners = new Map<string, Server>();
	private readonly tcpListeners = new Map<string, Server>();
	private readonly tokens = new Map<string, Buffer>();

	constructor(private readonly deps: SshAgentServerDeps) {}

	async allocateRunSocket(
		runId: string,
		identity: { companyId: string; agentId: string },
		socketHostPath: string,
	): Promise<AllocatedSocket> {
		await mkdir(dirname(socketHostPath), { recursive: true, mode: 0o700 });
		await rm(socketHostPath, { force: true });

		const fullIdentity: RunIdentity = { runId, ...identity };
		const tokenBytes = randomBytes(TCP_TOKEN_BYTES);
		this.tokens.set(runId, tokenBytes);
		this.registry.set(runId, {
			identity: fullIdentity,
			socketHostPath,
			resolveKeys: () => this.loadKeysForCompany(identity.companyId),
		});

		const unixServer = createServer((socket) => {
			this.handleAuthenticatedConnection(socket, runId).catch((e) => {
				log.error('ssh-agent connection error', { runId, error: (e as Error).message });
				socket.destroy();
			});
		});
		unixServer.on('error', (e) =>
			log.error('ssh-agent listener error', { runId, error: e.message }),
		);
		await new Promise<void>((resolve, reject) => {
			unixServer.once('error', reject);
			unixServer.listen(socketHostPath, () => {
				unixServer.removeListener('error', reject);
				resolve();
			});
		});
		this.listeners.set(runId, unixServer);

		const tcpServer = createServer((socket) => {
			this.handleTcpConnection(socket, runId).catch((e) => {
				log.error('ssh-agent tcp connection error', {
					runId,
					error: (e as Error).message,
				});
				socket.destroy();
			});
		});
		tcpServer.on('error', (e) =>
			log.error('ssh-agent tcp listener error', { runId, error: e.message }),
		);
		await new Promise<void>((resolve, reject) => {
			tcpServer.once('error', reject);
			tcpServer.listen({ host: TCP_LISTEN_HOST, port: 0 }, () => {
				tcpServer.removeListener('error', reject);
				resolve();
			});
		});
		this.tcpListeners.set(runId, tcpServer);
		const tcpHostPort = (tcpServer.address() as AddressInfo).port;
		const tokenHex = tokenBytes.toString('hex');

		log.debug('ssh-agent socket allocated', {
			runId,
			socketHostPath,
			tcpHostPort,
		});
		return { socketHostPath, tcpHostPort, tokenHex };
	}

	async releaseRunSocket(runId: string): Promise<void> {
		const server = this.listeners.get(runId);
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			this.listeners.delete(runId);
		}
		const tcpServer = this.tcpListeners.get(runId);
		if (tcpServer) {
			await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
			this.tcpListeners.delete(runId);
		}
		this.tokens.delete(runId);
		const entry = this.registry.get(runId);
		if (entry) {
			await rm(entry.socketHostPath, { force: true });
			this.registry.delete(runId);
		}
		log.debug('ssh-agent socket released', { runId });
	}

	async releaseAll(): Promise<void> {
		const runIds = new Set([...this.listeners.keys(), ...this.tcpListeners.keys()]);
		for (const runId of runIds) {
			await this.releaseRunSocket(runId);
		}
	}

	private async handleAuthenticatedConnection(socket: Socket, runId: string): Promise<void> {
		const entry = this.registry.get(runId);
		if (!entry) {
			socket.destroy();
			return;
		}

		const frames = new FrameReader();
		socket.on('data', (chunk) => {
			frames.push(chunk);
			void this.processFrames(frames, socket, entry.identity, entry.resolveKeys);
		});
	}

	private async handleTcpConnection(socket: Socket, runId: string): Promise<void> {
		const entry = this.registry.get(runId);
		const expectedToken = this.tokens.get(runId);
		if (!entry || !expectedToken) {
			socket.destroy();
			return;
		}

		const tokenChunks: Buffer[] = [];
		let collected = 0;
		let authenticated = false;
		const frames = new FrameReader();

		const onData = (chunk: Buffer) => {
			if (authenticated) {
				frames.push(chunk);
				void this.processFrames(frames, socket, entry.identity, entry.resolveKeys);
				return;
			}
			tokenChunks.push(chunk);
			collected += chunk.length;
			if (collected < TCP_TOKEN_BYTES) return;

			const all = Buffer.concat(tokenChunks);
			const candidate = all.subarray(0, TCP_TOKEN_BYTES);
			const remainder = all.subarray(TCP_TOKEN_BYTES);
			if (candidate.length !== expectedToken.length || !timingSafeEqual(candidate, expectedToken)) {
				log.warn('ssh-agent tcp auth failed', { runId });
				try {
					socket.write(encodeFailure());
				} catch {
					/* socket may already be closed */
				}
				socket.destroy();
				return;
			}
			authenticated = true;
			if (remainder.length > 0) {
				frames.push(remainder);
				void this.processFrames(frames, socket, entry.identity, entry.resolveKeys);
			}
		};
		socket.on('data', onData);
	}

	private async processFrames(
		frames: FrameReader,
		socket: Socket,
		identity: RunIdentity,
		resolveKeys: () => Promise<KeyEntry[]>,
	): Promise<void> {
		while (true) {
			const payload = frames.next();
			if (!payload) return;

			const message = decodeMessage(payload);
			try {
				switch (message.type) {
					case MSG_REQUEST_IDENTITIES: {
						const keys = await resolveKeys();
						const advertised: AgentIdentity[] = keys.map((k) => ({
							keyBlob: k.keyBlob,
							comment: k.comment,
						}));
						socket.write(encodeIdentitiesAnswer(advertised));
						break;
					}
					case MSG_SIGN_REQUEST: {
						const keys = await resolveKeys();
						const response = signWithMatchingKey(keys, message.req);
						if (response) {
							socket.write(encodeSignResponse(response));
						} else {
							log.warn('ssh-agent sign rejected: unknown key', { runId: identity.runId });
							socket.write(encodeFailure());
						}
						break;
					}
					default:
						socket.write(encodeFailure());
				}
			} catch (e) {
				log.error('ssh-agent handler error', {
					runId: identity.runId,
					error: (e as Error).message,
				});
				socket.write(encodeFailure());
			}
		}
	}

	private async loadKeysForCompany(companyId: string): Promise<KeyEntry[]> {
		const encryptionKey = this.deps.masterKeyManager.getKey();
		if (!encryptionKey) {
			throw new Error('Master key not available');
		}
		const result = await this.deps.db.query<{
			public_key: string;
			encrypted_value: string;
		}>(
			`SELECT k.public_key, s.encrypted_value
			 FROM company_ssh_keys k
			 JOIN secrets s ON s.id = k.private_key_secret_id
			 WHERE k.company_id = $1`,
			[companyId],
		);
		return result.rows.map((row) => {
			const blob = sshPublicKeyToBlob(row.public_key);
			const privateKeyPem = decrypt(row.encrypted_value, encryptionKey);
			const privateKey = createPrivateKey({ key: privateKeyPem, format: 'pem' });
			return {
				keyBlob: blob,
				comment: `hezo:${companyId}`,
				privateKey,
			};
		});
	}
}

function signWithMatchingKey(keys: KeyEntry[], req: SignRequest): Buffer | null {
	for (const key of keys) {
		if (key.keyBlob.equals(req.keyBlob)) {
			return ed25519SignatureBlob(key.privateKey, req.data);
		}
	}
	return null;
}

export function sshPublicKeyToBlob(sshPublicKey: string): Buffer {
	const parts = sshPublicKey.trim().split(/\s+/);
	if (parts.length < 2) {
		throw new Error(`invalid SSH public key: ${sshPublicKey.slice(0, 40)}`);
	}
	const base64 = parts[1];
	const blob = Buffer.from(base64, 'base64');
	if (parts[0] === 'ssh-ed25519') {
		const rawPub = blob.subarray(blob.length - 32);
		return ed25519PublicKeyBlob(rawPub);
	}
	return blob;
}

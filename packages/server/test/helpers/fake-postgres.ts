import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';

/**
 * A minimal Postgres wire-protocol server, enough to prove how the driver
 * negotiates TLS. Real Postgres cannot be told to present an untrusted
 * certificate from a unit test, so the SSLRequest handshake is spoken here
 * directly: the server can answer "S" and upgrade with a self-signed cert
 * (what a hosted provider with a private CA looks like to us), answer "N"
 * (a build without TLS support), and refuse a plaintext startup the way a
 * `force_ssl` provider does.
 *
 * Only the fragment the driver's connect path uses is implemented: the SSL
 * negotiation byte, the startup/auth exchange, and the simple query protocol
 * ("Q"), which is what `pg` uses for a query with no bind parameters.
 */

const SSL_REQUEST_CODE = 80877103;

export interface FakePostgresField {
	name: string;
	/** Postgres type oid for the column; text (25) by default. */
	oid?: number;
}

export interface FakePostgresResult {
	fields: FakePostgresField[];
	/** Row values in text format; null for SQL NULL. */
	rows: Array<Array<string | null>>;
}

export interface FakePostgresOptions {
	/**
	 * A cert/key pair: answer the SSLRequest with "S" and upgrade with it.
	 * `'off'`: answer "N" — this server cannot do TLS.
	 */
	tls: { cert: string; key: string } | 'off';
	/**
	 * `postgres` (default) negotiates via the SSLRequest byte and upgrades the
	 * socket in place. `direct` listens as a plain TLS server, which is the
	 * only shape that also works under Bun — its node:tls cannot upgrade a
	 * server socket (`new TLSSocket({isServer:true})` never handshakes), so the
	 * Bun-native tier drives the tolerant client path this way.
	 */
	negotiation?: 'postgres' | 'direct';
	/**
	 * Reject a startup that did not go through TLS, the way a provider with
	 * `hostssl`-only rules does. Ignored when TLS is off.
	 */
	requireTls?: boolean;
	/** Per-query response; falls back to a single text column when omitted. */
	respond?: (sql: string) => FakePostgresResult | undefined;
}

export interface FakePostgres {
	/** `postgres://…` URL pointing at this server. */
	url: string;
	port: number;
	/** True once any connection completed a TLS handshake. */
	readonly sawTls: boolean;
	/** True once any connection got past SSL negotiation in plaintext. */
	readonly sawPlaintext: boolean;
	close(): Promise<void>;
}

function frame(type: string, payload: Buffer): Buffer {
	const head = Buffer.alloc(5);
	head.write(type, 0, 'ascii');
	head.writeInt32BE(payload.length + 4, 1);
	return Buffer.concat([head, payload]);
}

function cstring(value: string): Buffer {
	return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);
}

function rowDescription(fields: FakePostgresField[]): Buffer {
	const count = Buffer.alloc(2);
	count.writeInt16BE(fields.length);
	const parts: Buffer[] = [count];
	for (const field of fields) {
		const meta = Buffer.alloc(18);
		meta.writeInt32BE(0, 0); // table oid
		meta.writeInt16BE(0, 4); // column attribute number
		meta.writeInt32BE(field.oid ?? 25, 6); // type oid (text)
		meta.writeInt16BE(-1, 10); // type length (varlena)
		meta.writeInt32BE(-1, 12); // type modifier
		meta.writeInt16BE(0, 16); // text format
		parts.push(cstring(field.name), meta);
	}
	return frame('T', Buffer.concat(parts));
}

function dataRow(values: Array<string | null>): Buffer {
	const count = Buffer.alloc(2);
	count.writeInt16BE(values.length);
	const parts: Buffer[] = [count];
	for (const value of values) {
		const len = Buffer.alloc(4);
		if (value === null) {
			len.writeInt32BE(-1);
			parts.push(len);
			continue;
		}
		const bytes = Buffer.from(value, 'utf8');
		len.writeInt32BE(bytes.length);
		parts.push(len, bytes);
	}
	return frame('D', Buffer.concat(parts));
}

function errorResponse(message: string): Buffer {
	return frame(
		'E',
		Buffer.concat([
			Buffer.from('S'),
			cstring('FATAL'),
			Buffer.from('C'),
			cstring('28000'),
			Buffer.from('M'),
			cstring(message),
			Buffer.from([0]),
		]),
	);
}

const READY_FOR_QUERY = frame('Z', Buffer.from('I', 'ascii'));

const AUTH_OK = (() => {
	const ok = Buffer.alloc(4);
	ok.writeInt32BE(0);
	const backendKey = Buffer.alloc(8);
	backendKey.writeInt32BE(1234, 0);
	backendKey.writeInt32BE(5678, 4);
	return Buffer.concat([
		frame('R', ok),
		frame('S', Buffer.concat([cstring('server_version'), cstring('16.4')])),
		frame('S', Buffer.concat([cstring('client_encoding'), cstring('UTF8')])),
		frame('K', backendKey),
		READY_FOR_QUERY,
	]);
})();

/** Start the fake server on an ephemeral port. */
export async function startFakePostgres(options: FakePostgresOptions): Promise<FakePostgres> {
	const state = { sawTls: false, sawPlaintext: false };
	const open = new Set<Socket>();

	/** Drive one session (plaintext socket, or the TLS socket layered on it). */
	const serveSession = (socket: Socket, secure: boolean, seed?: Buffer): void => {
		let buffer = seed ?? Buffer.alloc(0);
		let startupDone = false;

		const pump = (): void => {
			for (;;) {
				if (!startupDone) {
					// StartupMessage: Int32 length, then the parameter block.
					if (buffer.length < 4) return;
					const length = buffer.readInt32BE(0);
					if (buffer.length < length) return;
					buffer = buffer.subarray(length);
					startupDone = true;
					if (!secure && options.requireTls && options.tls !== 'off') {
						socket.end(errorResponse('no pg_hba.conf entry for host, no encryption'));
						return;
					}
					socket.write(AUTH_OK);
					continue;
				}
				// Typed message: byte tag, Int32 length (self-inclusive), payload.
				if (buffer.length < 5) return;
				const type = String.fromCharCode(buffer[0]);
				const length = buffer.readInt32BE(1);
				if (buffer.length < length + 1) return;
				const payload = buffer.subarray(5, length + 1);
				buffer = buffer.subarray(length + 1);
				if (type === 'X') {
					socket.end();
					return;
				}
				if (type !== 'Q') continue; // extended protocol is not exercised here
				const sql = payload.subarray(0, payload.length - 1).toString('utf8');
				const result = options.respond?.(sql) ?? { fields: [{ name: '?column?' }], rows: [['1']] };
				socket.write(
					Buffer.concat([
						rowDescription(result.fields),
						...result.rows.map(dataRow),
						frame('C', cstring(`SELECT ${result.rows.length}`)),
						READY_FOR_QUERY,
					]),
				);
			}
		};

		socket.on('error', () => undefined);
		socket.on('data', (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			pump();
		});
		pump();
	};

	if (options.negotiation === 'direct') {
		if (options.tls === 'off') throw new Error('direct negotiation requires a certificate');
		const tlsServer = createTlsServer(
			{ key: options.tls.key, cert: options.tls.cert },
			(socket) => {
				state.sawTls = true;
				open.add(socket);
				socket.on('close', () => open.delete(socket));
				serveSession(socket, true);
			},
		);
		tlsServer.on('tlsClientError', () => undefined);
		await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', () => resolve()));
		const directPort = (tlsServer.address() as AddressInfo).port;
		return {
			url: `postgres://hezo:hezo@127.0.0.1:${directPort}/hezo`,
			port: directPort,
			get sawTls() {
				return state.sawTls;
			},
			get sawPlaintext() {
				return state.sawPlaintext;
			},
			close: async () => {
				for (const socket of open) socket.destroy();
				open.clear();
				await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
			},
		};
	}

	const server: Server = createServer((socket) => {
		open.add(socket);
		socket.on('close', () => open.delete(socket));
		socket.on('error', () => undefined);
		socket.once('data', (chunk: Buffer) => {
			const isSslRequest =
				chunk.length >= 8 &&
				chunk.readInt32BE(0) === 8 &&
				chunk.readInt32BE(4) === SSL_REQUEST_CODE;
			if (!isSslRequest) {
				// The client skipped SSL negotiation entirely (sslmode=disable).
				state.sawPlaintext = true;
				serveSession(socket, false, chunk);
				return;
			}
			if (options.tls === 'off') {
				state.sawPlaintext = true;
				socket.write(Buffer.from('N', 'ascii'));
				serveSession(socket, false);
				return;
			}
			socket.write(Buffer.from('S', 'ascii'));
			const secure = new TLSSocket(socket, {
				isServer: true,
				key: options.tls.key,
				cert: options.tls.cert,
			});
			secure.on('error', () => undefined);
			secure.on('secure', () => {
				state.sawTls = true;
			});
			serveSession(secure, true);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
	const port = (server.address() as AddressInfo).port;

	return {
		url: `postgres://hezo:hezo@127.0.0.1:${port}/hezo`,
		port,
		get sawTls() {
			return state.sawTls;
		},
		get sawPlaintext() {
			return state.sawPlaintext;
		},
		close: async () => {
			for (const socket of open) socket.destroy();
			open.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

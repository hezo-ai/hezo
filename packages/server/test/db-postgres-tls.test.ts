// Behavioural cover for the external-Postgres TLS path: a fake server that
// speaks just enough of the startup protocol to reach the handshake, presenting
// a certificate signed by a CA this host does not trust — the exact shape of
// every managed provider (DigitalOcean, RDS, Azure) and the failure this fix is
// about. No real Postgres involved.
//
// Node tier only: Bun cannot wrap a server-side `tls.TLSSocket` around an
// already-connected socket, which the SSLRequest handshake requires. TLS on the
// production runtime is covered by test/bun/database-pg-driver.bun.test.ts
// against a real server; the connection-string resolution this fix turns on is
// pure JS and therefore runtime-independent (asserted under Bun there too).
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresDb } from '../src/db/drivers/postgres';
import { connectFailureHint, isRetryableConnectError } from '../src/db/postgres-connect-errors';
import { generateSelfSignedCert } from './helpers/self-signed-cert';

/** Postgres' SSLRequest body: an 8-byte message carrying this request code. */
const SSL_REQUEST_CODE = 80_877_103;

interface FakeTlsServer {
	port: number;
	/** True once a TLS handshake completed, i.e. the client accepted the cert. */
	handshakeCompleted: () => boolean;
	close: () => Promise<void>;
}

/**
 * Answer the SSLRequest with `S`, upgrade, then drop the connection as soon as
 * the handshake settles. Dropping immediately keeps a passing handshake from
 * waiting out the driver's connection timeout.
 */
async function startFakeTlsServer(cert: string, key: string): Promise<FakeTlsServer> {
	let completed = false;
	const server = net.createServer((socket) => {
		socket.once('data', (chunk) => {
			if (chunk.length < 8 || chunk.readInt32BE(4) !== SSL_REQUEST_CODE) {
				socket.destroy();
				return;
			}
			socket.write('S');
			const secured = new tls.TLSSocket(socket, { isServer: true, cert, key });
			secured.on('error', () => secured.destroy());
			secured.once('secure', () => {
				completed = true;
				secured.destroy();
			});
		});
		socket.on('error', () => socket.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (typeof address === 'string' || address === null) throw new Error('no port');
	return {
		port: address.port,
		handshakeCompleted: () => completed,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

describe('external Postgres TLS against a provider-private CA', () => {
	let server: FakeTlsServer | undefined;

	afterEach(async () => {
		await server?.close();
		server = undefined;
	});

	async function connectExpectingFailure(sslmode: string): Promise<unknown> {
		const { cert, key } = await generateSelfSignedCert('localhost');
		server = await startFakeTlsServer(cert, key);
		const url = `postgres://u:p@localhost:${server.port}/hezo?sslmode=${sslmode}`;
		try {
			const db = await PostgresDb.connect({ url });
			await db.close();
			throw new Error('expected the connection to fail after the handshake');
		} catch (err) {
			return err;
		}
	}

	it('completes the handshake under sslmode=require despite the untrusted CA', async () => {
		const err = await connectExpectingFailure('require');
		// The fix: TLS is negotiated and the certificate is accepted, so the
		// connection dies on the dropped socket rather than on verification.
		expect(server?.handshakeCompleted()).toBe(true);
		expect(connectFailureHint(err) ?? '').not.toMatch(/does not trust/);
		// A dropped socket is transient, so the open path should still retry.
		expect(isRetryableConnectError(err)).toBe(true);
	}, 15_000);

	it('still rejects an untrusted certificate under sslmode=verify-full', async () => {
		const err = await connectExpectingFailure('verify-full');
		expect(server?.handshakeCompleted()).toBe(false);
		// Classified from a real TLS error object, not a synthetic one.
		expect(connectFailureHint(err)).toMatch(/sslrootcert=\/path\/to\/ca\.crt/);
		expect(connectFailureHint(err)).toMatch(/sslmode=require to encrypt without verifying/);
		// Deterministic, so the open path must not spend its backoff on it.
		expect(isRetryableConnectError(err)).toBe(false);
	}, 15_000);
});

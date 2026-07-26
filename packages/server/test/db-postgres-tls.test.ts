// Behavioural cover for the external-Postgres TLS path, against a fake server
// presenting a certificate signed by a CA this host does not trust and issued
// for a different host name — the exact shape of every managed provider
// (DigitalOcean, RDS, Azure) and the failure this tolerance is about. The
// server speaks the real SSLRequest handshake and enough of the startup
// protocol to complete a query, so "it connects" is asserted, not inferred.
// No real Postgres involved.
//
// Node tier only: Bun cannot wrap a server-side `tls.TLSSocket` around an
// already-connected socket, which the SSLRequest upgrade requires. The
// tolerant client path on the production runtime is covered by
// test/bun/database-ssl-tolerance.bun.test.ts (direct TLS negotiation) and by
// test/bun/database-pg-driver.bun.test.ts against a real server.
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresDb } from '../src/db/drivers/postgres';
import { connectFailureHint, isRetryableConnectError } from '../src/db/postgres-connect-errors';
import { type FakePostgres, startFakePostgres } from './helpers/fake-postgres';
import { generateSelfSignedCert } from './helpers/self-signed-cert';

describe('external Postgres TLS against a provider-private CA', () => {
	let server: FakePostgres | undefined;

	afterEach(async () => {
		await server?.close();
		server = undefined;
	});

	/** A TLS-only server (plaintext startup refused), like a `force_ssl` provider. */
	async function startTlsOnlyServer(): Promise<FakePostgres> {
		// CN deliberately unrelated to 127.0.0.1: untrusted issuer AND host-name
		// mismatch, the two things hosted providers trip over.
		const cert = await generateSelfSignedCert('some-other-host.invalid');
		server = await startFakePostgres({ tls: cert, requireTls: true });
		return server;
	}

	it('connects with no sslmode at all, despite the untrusted CA', async () => {
		const s = await startTlsOnlyServer();
		const db = await PostgresDb.connect({ url: s.url });
		try {
			expect(db.tls).toBe('encrypted');
			expect((await db.query('SELECT 1')).rows.length).toBe(1);
			expect(s.sawTls).toBe(true);
		} finally {
			await db.close();
		}
	}, 15_000);

	it('connects under sslmode=require, despite the untrusted CA', async () => {
		const s = await startTlsOnlyServer();
		const db = await PostgresDb.connect({ url: `${s.url}?sslmode=require` });
		try {
			expect(db.tls).toBe('encrypted');
			expect(s.sawTls).toBe(true);
		} finally {
			await db.close();
		}
	}, 15_000);

	it('still rejects an untrusted certificate under sslmode=verify-full', async () => {
		const s = await startTlsOnlyServer();
		const err = await PostgresDb.connect({ url: `${s.url}?sslmode=verify-full` }).then(
			async (db) => {
				await db.close();
				throw new Error('expected verify-full to reject the untrusted certificate');
			},
			(e: unknown) => e,
		);
		expect(s.sawTls).toBe(false);
		// Classified from a real TLS error object, not a synthetic one.
		expect(connectFailureHint(err)).toMatch(/sslrootcert=\/path\/to\/ca\.crt/);
		expect(connectFailureHint(err)).toMatch(/asked for verification/);
		// Deterministic, so the open path must not spend its backoff on it.
		expect(isRetryableConnectError(err)).toBe(false);
	}, 15_000);
});

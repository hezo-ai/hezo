// Bun-native tier: the tolerant TLS path rides node:tls through node-postgres,
// and Bun's node:tls is its own implementation — a Node-only vitest run would
// say nothing about whether a hosted database with an unknown certificate
// actually connects in production. Mirrors the two runtime-sensitive legs of
// test/database-ssl-tolerance.test.ts.
import { describe, expect, it } from 'bun:test';
import { PostgresDb } from '../../src/db/drivers/postgres';
import { startFakePostgres } from '../helpers/fake-postgres';
import { generateSelfSignedCert } from '../helpers/self-signed-cert';

describe('PostgresDb TLS negotiation on the Bun runtime', () => {
	// Direct negotiation, not the SSLRequest upgrade: Bun's node:tls cannot
	// upgrade a *server* socket in place, so the fake server has to listen as a
	// plain TLS server here. The client side — the tolerant `rejectUnauthorized:
	// false` config riding Bun's TLS stack — is identical either way, and the
	// upgrade handshake itself is plain socket bytes covered by the Node tier.
	it('connects to a TLS server presenting an unknown, mismatched cert', async () => {
		const cert = await generateSelfSignedCert('some-other-host.invalid');
		const server = await startFakePostgres({ tls: cert, negotiation: 'direct' });
		try {
			const db = await PostgresDb.connect({ url: `${server.url}?sslnegotiation=direct` });
			try {
				expect(db.tls).toBe('encrypted');
				const r = await db.query('SELECT 1');
				expect(r.rows.length).toBe(1);
				expect(server.sawTls).toBe(true);
			} finally {
				await db.close();
			}
		} finally {
			await server.close();
		}
	});

	it('falls back to plaintext against a server without TLS support', async () => {
		const server = await startFakePostgres({ tls: 'off' });
		try {
			const db = await PostgresDb.connect({ url: server.url });
			try {
				expect(db.tls).toBe('none');
				expect(server.sawTls).toBe(false);
			} finally {
				await db.close();
			}
		} finally {
			await server.close();
		}
	});
});

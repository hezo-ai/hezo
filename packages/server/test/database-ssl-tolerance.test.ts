import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDb } from '../src/db/drivers/postgres';
import { openDatabase } from '../src/db/open';
import {
	describeTlsPosture,
	isSslUnsupportedError,
	type PostgresTlsPosture,
	planPostgresSsl,
} from '../src/db/postgres-ssl';
import { type FakePostgres, startFakePostgres } from './helpers/fake-postgres';
import { generateSelfSignedCert } from './helpers/self-signed-cert';

/**
 * Hosted Postgres is tolerant by design: TLS is attempted even when the URL
 * says nothing about it, the server certificate is not verified unless the
 * operator opts in, and a server with no TLS support still connects. The
 * against-a-real-handshake legs live in db-postgres-tls.test.ts; this file
 * pins the resolution itself, the plaintext fallback, and the entry point
 * `hezo backup` / `hezo restore --database-url` share with the server.
 */

const BASE = 'postgres://u:p@db.example.com:5432/hezo';

describe('planPostgresSsl', () => {
	it('defaults to TLS with verification off and a plaintext fallback', () => {
		const plan = planPostgresSsl(BASE, {});
		expect(plan.tls).toBe<PostgresTlsPosture>('encrypted');
		expect(plan.ssl).toMatchObject({ rejectUnauthorized: false });
		expect(plan.plaintextFallback).toBe(true);
		expect(plan.connectionString).toBe(BASE);
	});

	it('keeps verification off for sslmode=require and strips the param', () => {
		// The param has to go: node-postgres merges the parsed connection string
		// OVER the explicit ssl option, so a URL carrying sslmode would silently
		// re-enable verification.
		const plan = planPostgresSsl(`${BASE}?sslmode=require`, {});
		expect(plan.tls).toBe<PostgresTlsPosture>('encrypted');
		expect(plan.ssl).toMatchObject({ rejectUnauthorized: false });
		expect(plan.connectionString).not.toContain('sslmode');
		// require means "TLS or bust" — no silent downgrade to plaintext.
		expect(plan.plaintextFallback).toBe(false);
	});

	it.each([
		'no-verify',
		'prefer',
		'allow',
		'true',
		'1',
	])('treats sslmode=%s as tolerant TLS', (mode) => {
		const plan = planPostgresSsl(`${BASE}?sslmode=${mode}`, {});
		expect(plan.tls).toBe<PostgresTlsPosture>('encrypted');
		expect(plan.ssl).toMatchObject({ rejectUnauthorized: false });
	});

	it.each(['disable', 'false', '0'])('honours sslmode=%s as an explicit opt-out', (mode) => {
		const plan = planPostgresSsl(`${BASE}?sslmode=${mode}`, {});
		expect(plan.tls).toBe<PostgresTlsPosture>('none');
		expect(plan.ssl).toBe(false);
		expect(plan.plaintextFallback).toBe(false);
	});

	it('verifies chain and hostname for sslmode=verify-full', () => {
		const plan = planPostgresSsl(`${BASE}?sslmode=verify-full`, {});
		expect(plan.tls).toBe<PostgresTlsPosture>('verified');
		expect(plan.ssl).toMatchObject({ rejectUnauthorized: true });
		expect((plan.ssl as { checkServerIdentity?: unknown }).checkServerIdentity).toBeUndefined();
		expect(plan.plaintextFallback).toBe(false);
	});

	it('verifies the chain but not the hostname for sslmode=verify-ca', () => {
		const plan = planPostgresSsl(`${BASE}?sslmode=verify-ca`, {});
		expect(plan.tls).toBe<PostgresTlsPosture>('verified-ca');
		expect(plan.ssl).toMatchObject({ rejectUnauthorized: true });
		expect((plan.ssl as { checkServerIdentity?: () => unknown }).checkServerIdentity?.()).toBe(
			undefined,
		);
	});

	it('loads a supplied root CA and treats it as a request to verify', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'hezo-ssl-'));
		const caPath = join(dir, 'root.crt');
		const { cert } = await generateSelfSignedCert('db.example.com');
		await writeFile(caPath, cert);

		const plan = planPostgresSsl(`${BASE}?sslrootcert=${encodeURIComponent(caPath)}`, {});
		expect(plan.tls).toBe<PostgresTlsPosture>('verified-ca');
		expect(plan.ssl).toMatchObject({ rejectUnauthorized: true, ca: cert });
	});

	it('reports a missing certificate file instead of silently ignoring it', () => {
		expect(() => planPostgresSsl(`${BASE}?sslrootcert=/nope/missing.crt`, {})).toThrow(
			/sslrootcert/,
		);
	});

	it('requires TLS when the URL asks for direct negotiation', () => {
		const plan = planPostgresSsl(`${BASE}?sslnegotiation=direct`, {});
		expect(plan.sslNegotiation).toBe('direct');
		expect(plan.plaintextFallback).toBe(false);
		expect(plan.connectionString).not.toContain('sslnegotiation');
	});

	describe('connection-string handling', () => {
		it('preserves every non-TLS param', () => {
			const plan = planPostgresSsl(
				`${BASE}?sslmode=require&application_name=x&connect_timeout=5`,
				{},
			);
			const params = new URL(plan.connectionString).searchParams;
			expect(params.get('application_name')).toBe('x');
			expect(params.get('connect_timeout')).toBe('5');
			expect(params.has('sslmode')).toBe(false);
		});

		it('leaves a string with no TLS params byte-identical', () => {
			// No rebuild, so hand-written values are never re-encoded.
			const url = `${BASE}?host=/var/run/postgresql&options=-c geqo=off`;
			expect(planPostgresSsl(url, {}).connectionString).toBe(url);
		});

		it('round-trips a rebuilt string through the parser unchanged', () => {
			// Stripping re-serializes, which percent-encodes a hand-written unix
			// socket path — pg-connection-string decodes query values, so the
			// config it resolves is identical either way.
			const plan = planPostgresSsl(`${BASE}?sslmode=require&host=/var/run/postgresql`, {});
			const parsed = new pg.Client({ connectionString: plan.connectionString });
			expect((parsed as unknown as { host: string }).host).toBe('/var/run/postgresql');
		});

		it('resolves a repeated sslmode to its last occurrence, as the parser does', () => {
			const plan = planPostgresSsl(`${BASE}?sslmode=require&sslmode=disable`, {});
			expect(plan.tls).toBe<PostgresTlsPosture>('none');
			expect(plan.ssl).toBe(false);
		});

		it('falls back to tolerant TLS for a string that is not a URL', () => {
			// Defensive only — openDatabase rejects these before the driver runs.
			const plan = planPostgresSsl('host=db.example user=hezo', {});
			expect(plan.connectionString).toBe('host=db.example user=hezo');
			expect(plan.tls).toBe<PostgresTlsPosture>('encrypted');
		});
	});

	describe('PGSSLMODE', () => {
		it('applies only when the URL carries no sslmode of its own', () => {
			expect(planPostgresSsl(BASE, { PGSSLMODE: 'verify-full' }).tls).toBe<PostgresTlsPosture>(
				'verified',
			);
			expect(planPostgresSsl(BASE, { PGSSLMODE: 'disable' }).ssl).toBe(false);
			// libpq's `require` means encrypt-without-verifying here too.
			expect(planPostgresSsl(BASE, { PGSSLMODE: 'require' }).tls).toBe<PostgresTlsPosture>(
				'encrypted',
			);
			expect(
				planPostgresSsl(`${BASE}?sslmode=require`, { PGSSLMODE: 'verify-full' }).tls,
			).toBe<PostgresTlsPosture>('encrypted');
		});

		it('reads the env passed in rather than the ambient process env', () => {
			expect(planPostgresSsl(BASE, {}).tls).toBe<PostgresTlsPosture>('encrypted');
		});
	});

	it('classifies only the "server has no SSL" failure as fallback-worthy', () => {
		expect(isSslUnsupportedError(new Error('The server does not support SSL connections'))).toBe(
			true,
		);
		expect(isSslUnsupportedError(new Error('self-signed certificate in chain'))).toBe(false);
		expect(isSslUnsupportedError('nope')).toBe(false);
	});
});

describe('describeTlsPosture', () => {
	it('names what each posture does and does not protect', () => {
		expect(describeTlsPosture('none')).toContain('no encryption');
		expect(describeTlsPosture('encrypted')).toContain('certificate not verified');
		expect(describeTlsPosture('encrypted')).toContain('sslmode=verify-full');
		expect(describeTlsPosture('verified-ca')).toContain('hostname not checked');
		expect(describeTlsPosture('verified')).toContain('CA + hostname');
	});
});

describe('PostgresDb against a server without TLS', () => {
	const withServer = async (
		options: Parameters<typeof startFakePostgres>[0],
		body: (server: FakePostgres) => Promise<void>,
	): Promise<void> => {
		const server = await startFakePostgres(options);
		try {
			await body(server);
		} finally {
			await server.close();
		}
	};

	it('falls back to plaintext when the server answers the SSLRequest with "no"', async () => {
		await withServer({ tls: 'off' }, async (server) => {
			const db = await PostgresDb.connect({ url: server.url });
			try {
				expect(db.tls).toBe<PostgresTlsPosture>('none');
				expect((await db.query('SELECT 1')).rows.length).toBe(1);
				expect(server.sawTls).toBe(false);
				expect(server.sawPlaintext).toBe(true);
			} finally {
				await db.close();
			}
		});
	});

	it('skips the SSLRequest entirely when the operator passes sslmode=disable', async () => {
		const cert = await generateSelfSignedCert('some-other-host.invalid');
		await withServer({ tls: cert }, async (server) => {
			const db = await PostgresDb.connect({ url: `${server.url}?sslmode=disable` });
			try {
				expect(db.tls).toBe<PostgresTlsPosture>('none');
				expect(server.sawTls).toBe(false);
				expect(server.sawPlaintext).toBe(true);
			} finally {
				await db.close();
			}
		});
	});
});

describe('openDatabase against a TLS-only hosted database', () => {
	let server: FakePostgres;

	beforeAll(async () => {
		const cert = await generateSelfSignedCert('some-other-host.invalid');
		server = await startFakePostgres({
			tls: cert,
			requireTls: true,
			// Enough for the compatibility preflight; anything else is SELECT 1.
			respond: (sql) =>
				sql.includes('server_version_num')
					? {
							fields: [{ name: 'num', oid: 23 }, { name: 'version' }],
							rows: [['160004', '16.4']],
						}
					: undefined,
		});
	});
	afterAll(() => server.close());

	it('opens (and so backs up / restores) without any sslmode in the URL', async () => {
		// `hezo backup` and `hezo restore --database-url` open the target through
		// this exact function, so the tolerance reaches them too.
		const opened = await openDatabase({ dataDir: '/unused', databaseUrl: server.url });
		try {
			expect(opened.storage.backend).toBe('external');
			expect(opened.storage.server_version).toBe('16.4');
			expect(server.sawTls).toBe(true);
			// The redacted display never carries the credentials.
			expect(opened.storage.display).not.toContain('hezo:hezo');
		} finally {
			await opened.db.close();
		}
	});
});

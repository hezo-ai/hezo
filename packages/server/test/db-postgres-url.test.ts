import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	describeTlsPosture,
	normalizePostgresUrl,
	type PostgresTlsPosture,
} from '../src/db/postgres-url';

const BASE = 'postgres://u:p@db.example:5432/hezo';

/**
 * Resolve a connection string exactly as node-postgres will. The Client
 * constructor is pure config resolution — it opens no socket, resolves no DNS,
 * and registers no timers — so this asserts on the real parser without a
 * server.
 */
function resolvedSsl(url: string): unknown {
	return new pg.Client({ connectionString: url }).connectionParameters.ssl;
}

describe('normalizePostgresUrl', () => {
	let prevSslMode: string | undefined;
	let prevRootCert: string | undefined;

	beforeEach(() => {
		prevSslMode = process.env.PGSSLMODE;
		prevRootCert = process.env.PGSSLROOTCERT;
		delete process.env.PGSSLMODE;
		delete process.env.PGSSLROOTCERT;
	});

	afterEach(() => {
		if (prevSslMode === undefined) delete process.env.PGSSLMODE;
		else process.env.PGSSLMODE = prevSslMode;
		if (prevRootCert === undefined) delete process.env.PGSSLROOTCERT;
		else process.env.PGSSLROOTCERT = prevRootCert;
	});

	describe('the modes it opts in', () => {
		it('makes sslmode=require mean encrypted-but-unverified, as libpq does', () => {
			const out = normalizePostgresUrl(`${BASE}?sslmode=require`);
			expect(out.url).toBe(`${BASE}?sslmode=require&uselibpqcompat=true`);
			expect(out.tls).toBe<PostgresTlsPosture>('encrypted');
			// This is the whole bug: without the opt-in it resolves to `{}`, i.e.
			// full verification against the public CA store, which every
			// provider-private CA fails.
			expect(resolvedSsl(`${BASE}?sslmode=require`)).toEqual({});
			expect(resolvedSsl(out.url)).toEqual({ rejectUnauthorized: false });
		});

		it('opts sslmode=prefer in the same way', () => {
			const out = normalizePostgresUrl(`${BASE}?sslmode=prefer`);
			expect(out.url).toBe(`${BASE}?sslmode=prefer&uselibpqcompat=true`);
			expect(out.tls).toBe<PostgresTlsPosture>('encrypted');
			expect(resolvedSsl(out.url)).toEqual({ rejectUnauthorized: false });
		});

		it('reports require + sslrootcert as CA-verified rather than merely encrypted', () => {
			const out = normalizePostgresUrl(`${BASE}?sslmode=require&sslrootcert=/etc/hezo/ca.crt`);
			expect(out.url).toContain('uselibpqcompat=true');
			expect(out.tls).toBe<PostgresTlsPosture>('verified-ca');
		});

		it('opts verify-ca in only when a CA file is supplied', () => {
			const withCa = normalizePostgresUrl(`${BASE}?sslmode=verify-ca&sslrootcert=/etc/hezo/ca.crt`);
			expect(withCa.url).toContain('uselibpqcompat=true');
			expect(withCa.tls).toBe<PostgresTlsPosture>('verified-ca');
		});
	});

	describe('the modes it deliberately leaves alone', () => {
		it('never opts no-verify in — doing so would silently re-enable verification', () => {
			const out = normalizePostgresUrl(`${BASE}?sslmode=no-verify`);
			expect(out.url).toBe(`${BASE}?sslmode=no-verify`);
			expect(out.tls).toBe<PostgresTlsPosture>('encrypted');
			expect(resolvedSsl(out.url)).toEqual({ rejectUnauthorized: false });
			// The trap this guards: `no-verify` is not a libpq mode, so under the
			// libpq branch it falls through to the verify-everything default.
			expect(resolvedSsl(`${BASE}?sslmode=no-verify&uselibpqcompat=true`)).toEqual({});
		});

		it('never opts verify-ca in without a CA file — the libpq branch throws there', () => {
			const out = normalizePostgresUrl(`${BASE}?sslmode=verify-ca`);
			expect(out.url).toBe(`${BASE}?sslmode=verify-ca`);
			expect(out.tls).toBe<PostgresTlsPosture>('verified');
			expect(() => resolvedSsl(out.url)).not.toThrow();
			expect(() => resolvedSsl(`${BASE}?sslmode=verify-ca&uselibpqcompat=true`)).toThrow(
				/requires specifying a CA/,
			);
		});

		it('leaves verify-full byte-identical and still fully verifying', () => {
			const out = normalizePostgresUrl(`${BASE}?sslmode=verify-full`);
			expect(out.url).toBe(`${BASE}?sslmode=verify-full`);
			expect(out.tls).toBe<PostgresTlsPosture>('verified');
			expect(resolvedSsl(out.url)).toEqual({});
		});

		it('leaves sslmode=disable alone', () => {
			const out = normalizePostgresUrl(`${BASE}?sslmode=disable`);
			expect(out.url).toBe(`${BASE}?sslmode=disable`);
			expect(out.tls).toBe<PostgresTlsPosture>('none');
			expect(resolvedSsl(out.url)).toBe(false);
		});

		it('reports a URL with no sslmode as plaintext, and does not touch it', () => {
			const out = normalizePostgresUrl(BASE);
			expect(out.url).toBe(BASE);
			expect(out.tls).toBe<PostgresTlsPosture>('none');
			// node-postgres does not imply TLS from the scheme.
			expect(resolvedSsl(out.url)).toBe(false);
		});

		it('treats an unrecognised sslmode as verifying, matching the parser default', () => {
			const out = normalizePostgresUrl(`${BASE}?sslmode=allow`);
			expect(out.url).toBe(`${BASE}?sslmode=allow`);
			expect(out.tls).toBe<PostgresTlsPosture>('verified');
			expect(resolvedSsl(out.url)).toEqual({});
		});

		it('does not case-fold — the parser matches the literal token', () => {
			const out = normalizePostgresUrl(`${BASE}?sslmode=REQUIRE`);
			expect(out.url).toBe(`${BASE}?sslmode=REQUIRE`);
			// Matches no branch either way, so it lands on verify-everything.
			expect(resolvedSsl(out.url)).toEqual({});
			expect(out.tls).toBe<PostgresTlsPosture>('verified');
		});

		it('reports TLS on when only ssl file params are given', () => {
			const out = normalizePostgresUrl(`${BASE}?sslrootcert=/etc/hezo/ca.crt`);
			expect(out.url).toBe(`${BASE}?sslrootcert=/etc/hezo/ca.crt`);
			expect(out.tls).toBe<PostgresTlsPosture>('verified');
		});
	});

	describe('operator overrides', () => {
		it('respects an explicit uselibpqcompat=true and adds nothing', () => {
			const url = `${BASE}?sslmode=require&uselibpqcompat=true`;
			const out = normalizePostgresUrl(url);
			expect(out.url).toBe(url);
			expect(out.tls).toBe<PostgresTlsPosture>('encrypted');
		});

		it('respects an explicit opt-out and reports the legacy posture', () => {
			const url = `${BASE}?sslmode=require&uselibpqcompat=false`;
			const out = normalizePostgresUrl(url);
			expect(out.url).toBe(url);
			expect(out.tls).toBe<PostgresTlsPosture>('verified');
			expect(resolvedSsl(url)).toEqual({});
		});
	});

	describe('query-string handling', () => {
		it('resolves a repeated sslmode to its last occurrence, as the parser does', () => {
			// The parser assigns each query entry in order, so the last wins;
			// URLSearchParams.get() would report the first and pick the wrong branch.
			const out = normalizePostgresUrl(`${BASE}?sslmode=require&sslmode=disable`);
			expect(out.url).toBe(`${BASE}?sslmode=require&sslmode=disable`);
			expect(out.tls).toBe<PostgresTlsPosture>('none');
			expect(resolvedSsl(out.url)).toBe(false);
		});

		it('does not double up the separator after a trailing bare question mark', () => {
			const out = normalizePostgresUrl(`${BASE}?`);
			expect(out.url).toBe(`${BASE}?`);
			// And with a param present the separator is an ampersand.
			expect(normalizePostgresUrl(`${BASE}?sslmode=require`).url).toBe(
				`${BASE}?sslmode=require&uselibpqcompat=true`,
			);
		});

		it('keeps the param out of a fragment', () => {
			const out = normalizePostgresUrl(`${BASE}?sslmode=require#notes`);
			expect(out.url).toContain('uselibpqcompat=true');
			expect(new URL(out.url).searchParams.get('uselibpqcompat')).toBe('true');
			expect(resolvedSsl(out.url)).toEqual({ rejectUnauthorized: false });
		});

		it('preserves hand-written values that a URL round-trip would re-encode', () => {
			const url = 'postgres://u:p@localhost/hezo?sslmode=require&host=/var/run/postgresql';
			const out = normalizePostgresUrl(url);
			expect(out.url).toBe(`${url}&uselibpqcompat=true`);
			expect(out.url).not.toContain('%2F');
		});

		it('returns an unparseable string untouched', () => {
			const out = normalizePostgresUrl('host=db.example user=hezo sslmode=require');
			expect(out.url).toBe('host=db.example user=hezo sslmode=require');
			expect(out.tls).toBe<PostgresTlsPosture>('unspecified');
		});
	});

	describe('PGSSLMODE', () => {
		it('reports the env posture only when the URL configures no TLS', () => {
			process.env.PGSSLMODE = 'require';
			// node-postgres reads the env var into a plain `ssl: true`, i.e. full
			// verification — the URL is the place to express intent.
			expect(normalizePostgresUrl(BASE).tls).toBe<PostgresTlsPosture>('verified');
			expect(resolvedSsl(BASE)).toBe(true);

			process.env.PGSSLMODE = 'no-verify';
			expect(normalizePostgresUrl(BASE).tls).toBe<PostgresTlsPosture>('encrypted');

			process.env.PGSSLMODE = 'disable';
			expect(normalizePostgresUrl(BASE).tls).toBe<PostgresTlsPosture>('none');
		});

		it('is overridden by an sslmode in the URL', () => {
			process.env.PGSSLMODE = 'verify-full';
			const out = normalizePostgresUrl(`${BASE}?sslmode=require`);
			expect(out.tls).toBe<PostgresTlsPosture>('encrypted');
			expect(resolvedSsl(out.url)).toEqual({ rejectUnauthorized: false });
		});

		it('reads the env passed in rather than the ambient process env', () => {
			expect(normalizePostgresUrl(BASE, { PGSSLMODE: 'verify-full' }).tls).toBe<PostgresTlsPosture>(
				'verified',
			);
			expect(normalizePostgresUrl(BASE, {}).tls).toBe<PostgresTlsPosture>('none');
		});
	});

	it('produces strings node-postgres still accepts (pg v9 tripwire)', () => {
		// If this fails after a `pg` major bump: pg-connection-string v3 defaults
		// to libpq semantics and rejects a redundant `uselibpqcompat`. Delete
		// src/db/postgres-url.ts and its call site in src/db/drivers/postgres.ts.
		for (const mode of ['require', 'prefer', 'verify-full', 'disable', 'no-verify', 'verify-ca']) {
			const { url } = normalizePostgresUrl(`${BASE}?sslmode=${mode}`);
			expect(() => new pg.Client({ connectionString: url }), mode).not.toThrow();
		}
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

import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';

/**
 * TLS resolution for the external ("hosted") Postgres connection.
 *
 * Hezo connects to a database the operator chose and pointed it at, over a
 * connection string that already carries its credentials. Certificate
 * verification is therefore not the security boundary here, but it is a
 * constant source of failed deployments: managed providers hand out strings
 * with no `sslmode` at all, terminate TLS with a provider-private CA
 * (DigitalOcean, RDS, Azure), or present a certificate whose name does not
 * match the pooler endpoint. Both halves of that used to bite - a URL without
 * `sslmode` never offered TLS, so a server that requires it refused us, and a
 * URL with one was verified against the host's public CA store.
 *
 * So the resolution is deliberately tolerant:
 *
 * - TLS is attempted on every connection, even when the URL says nothing
 *   about it, so a server that REQUIRES TLS just works.
 * - The server certificate is not verified - unknown, self-signed,
 *   private-CA and hostname-mismatched certificates all connect.
 * - A server that cannot do TLS at all falls back to plaintext (libpq's
 *   `prefer` behaviour), so local and containerised Postgres are unchanged.
 *
 * Verification is opt-in, exactly as with libpq: `sslmode=verify-ca` /
 * `sslmode=verify-full` (optionally with `sslrootcert=`), or `sslmode=disable`
 * to refuse TLS outright. Supplying `sslrootcert=` on its own also implies
 * chain verification - providing a CA only makes sense if it gets used.
 *
 * Resolving it here rather than through the connection string is what makes
 * that possible at all: node-postgres re-parses `connectionString` and merges
 * the result OVER the caller's config, so a URL carrying `sslmode` silently
 * wins over an explicit `ssl` option. The planner therefore strips every TLS
 * parameter from the string and returns the TLS configuration separately —
 * which also makes the behaviour independent of which pg-connection-string
 * reading (legacy or libpq) the installed parser implements.
 */

/** What the resolved TLS configuration actually protects against. */
export type PostgresTlsPosture =
	/** No TLS at all - the session is plaintext. */
	| 'none'
	/** Encrypted, but the server certificate is not verified. */
	| 'encrypted'
	/** Certificate chain verified against a CA; hostname not checked. */
	| 'verified-ca'
	/** Certificate chain and hostname both verified. */
	| 'verified';

export interface PostgresSslPlan {
	/** The connection string to hand to node-postgres, TLS params removed. */
	connectionString: string;
	/** Value for `pg.Pool`'s `ssl` option: `false`, or node TLS options. */
	ssl: false | ConnectionOptions;
	/** `pg`'s `sslnegotiation` option, when the URL asked for direct TLS. */
	sslNegotiation?: 'postgres' | 'direct';
	/** Retry once without TLS if the server answers the SSLRequest with "no". */
	plaintextFallback: boolean;
	tls: PostgresTlsPosture;
}

/** Everything `pg` / `pg-connection-string` derive TLS behaviour from. */
const TLS_URL_PARAMS = new Set([
	'ssl',
	'sslmode',
	'sslcert',
	'sslkey',
	'sslrootcert',
	'sslpassword',
	'sslnegotiation',
	'uselibpqcompat',
]);

/** libpq sslmode values, plus the `ssl=` spellings node-postgres accepts. */
function normalizeMode(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const value = raw.trim().toLowerCase();
	if (value === '') return undefined;
	if (value === 'false' || value === '0') return 'disable';
	if (value === 'true' || value === '1') return 'require';
	return value;
}

function readPem(path: string, param: string): string {
	try {
		return readFileSync(path, 'utf8');
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		throw new Error(`Cannot read the ${param} file referenced by the database URL: ${cause}`);
	}
}

/**
 * Derive the TLS plan for a Postgres connection string. Pure apart from
 * reading any certificate files the URL points at.
 */
export function planPostgresSsl(
	rawUrl: string,
	env: Record<string, string | undefined> = process.env,
): PostgresSslPlan {
	let url: URL | null;
	try {
		url = new URL(rawUrl);
	} catch {
		// Defensive only - openDatabase rejects non-URL strings before this runs.
		url = null;
	}

	// The query folds by assigning each entry in order, so a repeated param
	// resolves to its LAST occurrence - same as pg-connection-string.
	const params = new Map<string, string>();
	if (url) {
		for (const [key, value] of url.searchParams) params.set(key.toLowerCase(), value);
	}

	// Only rebuild the URL when there is something to strip: re-serializing a
	// connection string re-encodes values the operator wrote by hand (a
	// unix-socket `host=/var/run/…`, a space inside `options=`), and the
	// userinfo is the last place to risk that gratuitously.
	let connectionString = rawUrl;
	if (url && [...params.keys()].some((key) => TLS_URL_PARAMS.has(key))) {
		const stripped = new URL(rawUrl);
		for (const key of [...stripped.searchParams.keys()]) {
			if (TLS_URL_PARAMS.has(key.toLowerCase())) stripped.searchParams.delete(key);
		}
		connectionString = stripped.toString();
	}

	// PGSSLMODE is what node-postgres itself falls back to; honour it so an
	// operator who set it does not silently lose the posture they asked for.
	const requested = normalizeMode(params.get('sslmode') ?? params.get('ssl') ?? env.PGSSLMODE);
	const direct = params.get('sslnegotiation')?.trim().toLowerCase() === 'direct';

	if (requested === 'disable') {
		return { connectionString, ssl: false, plaintextFallback: false, tls: 'none' };
	}

	const material: ConnectionOptions = {};
	const rootCert = params.get('sslrootcert');
	if (rootCert) material.ca = readPem(rootCert, 'sslrootcert');
	const clientCert = params.get('sslcert');
	if (clientCert) material.cert = readPem(clientCert, 'sslcert');
	const clientKey = params.get('sslkey');
	if (clientKey) material.key = readPem(clientKey, 'sslkey');
	const passphrase = params.get('sslpassword');
	if (passphrase) material.passphrase = passphrase;

	// Only an explicit verify-* (or a supplied CA, which libpq also treats as
	// "verify the chain") turns verification back on.
	let tls: PostgresTlsPosture;
	if (requested === 'verify-full') tls = 'verified';
	else if (requested === 'verify-ca' || material.ca !== undefined) tls = 'verified-ca';
	else tls = 'encrypted';

	const ssl: ConnectionOptions = { ...material, rejectUnauthorized: tls !== 'encrypted' };
	// verify-ca checks the chain but not the hostname (libpq semantics); node
	// verifies the hostname unless checkServerIdentity opts out.
	if (tls === 'verified-ca') ssl.checkServerIdentity = () => undefined;

	return {
		connectionString,
		ssl,
		...(direct ? { sslNegotiation: 'direct' as const } : {}),
		// TLS was not explicitly demanded ⇒ a server that cannot do TLS is still
		// usable. `require`/`verify-*` and direct negotiation mean "TLS or bust".
		plaintextFallback:
			!direct && (requested === undefined || requested === 'prefer' || requested === 'allow'),
		tls,
	};
}

/**
 * True when the connection failed because the server answered the SSLRequest
 * with "N" - the one failure the tolerant plan retries in plaintext. Any other
 * TLS error (handshake, protocol) is a real failure and surfaces as-is.
 */
export function isSslUnsupportedError(err: unknown): boolean {
	return err instanceof Error && /does not support SSL/i.test(err.message);
}

/** One-line operator-facing rendering of a posture, for the startup log. */
export function describeTlsPosture(tls: PostgresTlsPosture): string {
	switch (tls) {
		case 'none':
			return 'TLS off (no encryption)';
		case 'encrypted':
			return 'TLS encrypted, certificate not verified (use sslmode=verify-full to verify)';
		case 'verified-ca':
			return 'TLS verified against the supplied CA (hostname not checked)';
		case 'verified':
			return 'TLS verified (CA + hostname)';
	}
}

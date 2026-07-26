/**
 * TLS normalization for the external-Postgres connection string.
 *
 * node-postgres 8 resolves `sslmode` through pg-connection-string's legacy
 * branch, where `prefer`, `require` and `verify-ca` are all treated as aliases
 * for `verify-full` — full chain *and* hostname verification against the host's
 * public CA store. No other Postgres client reads them that way: libpq (and so
 * `psql`, and so every connection string a managed provider hands out) treats
 * `require` as "encrypt, do not verify the certificate". Managed Postgres
 * (DigitalOcean, AWS RDS, Azure) and most self-hosted servers present a
 * certificate signed by a provider-private CA, so the legacy reading rejects
 * them with "self signed certificate in certificate chain" on a URL that `psql`
 * connects with happily.
 *
 * pg-connection-string already implements libpq semantics behind an opt-in
 * `uselibpqcompat=true` query parameter, and makes them the default in its next
 * major (shipping with pg 9). Opting the URL in is therefore forward-compatible
 * rather than a workaround.
 *
 * DELETE THIS MODULE AND ITS CALL SITE IN `drivers/postgres.ts` WHEN pg REACHES
 * v9: pg-connection-string v3 throws when the parameter is supplied on a parser
 * that already defaults to libpq semantics.
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
	| 'verified'
	/** Not a parseable URL - the posture can't be determined here. */
	| 'unspecified';

export interface NormalizedPostgresUrl {
	/** The connection string to hand to node-postgres. */
	url: string;
	/** Effective TLS posture once node-postgres has resolved the string. */
	tls: PostgresTlsPosture;
}

const LIBPQ_COMPAT_PARAM = 'uselibpqcompat=true';

/** Query params that make pg-connection-string load key material from disk. */
const SSL_FILE_PARAMS = ['sslcert', 'sslkey', 'sslrootcert'] as const;

interface PostureInput {
	sslmode: string | undefined;
	/** A `sslrootcert=` path is present, so a CA is supplied explicitly. */
	hasCaFile: boolean;
	/** Any of the ssl file params is present - enough to switch TLS on. */
	hasSslFile: boolean;
	/** Whether libpq semantics govern the `sslmode` reading. */
	libpq: boolean;
	pgSslMode: string | undefined;
}

/**
 * Mirror of pg-connection-string's resolution plus node-postgres' `PGSSLMODE`
 * fallback, reduced to the operator-facing question "what does this protect
 * against". Kept in lockstep with the parser it describes: matching is exact
 * (the parser switches on the literal token, so `REQUIRE` matches no branch and
 * lands on the verify-everything default).
 */
function tlsPosture(input: PostureInput): PostgresTlsPosture {
	const { sslmode, hasCaFile, hasSslFile, libpq, pgSslMode } = input;

	if (sslmode === undefined) {
		// The file params alone switch TLS on with the verify-everything default.
		if (hasSslFile) return 'verified';
		// node-postgres reads PGSSLMODE only when the URL configures no TLS at
		// all, and maps every verifying mode onto a plain `ssl: true`.
		switch (pgSslMode) {
			case 'no-verify':
				return 'encrypted';
			case 'prefer':
			case 'require':
			case 'verify-ca':
			case 'verify-full':
				return 'verified';
			default:
				return 'none';
		}
	}

	if (sslmode === 'disable') return 'none';

	if (libpq) {
		switch (sslmode) {
			case 'prefer':
				return 'encrypted';
			case 'require':
				// A supplied CA upgrades `require` to chain verification with the
				// hostname check disabled.
				return hasCaFile ? 'verified-ca' : 'encrypted';
			case 'verify-ca':
				return 'verified-ca';
			default:
				// `verify-full`, and any token the parser doesn't recognise, leave
				// the verify-everything default in place. `no-verify` is not a libpq
				// mode and lands here too, which is precisely why the normalizer
				// never opts it in.
				return 'verified';
		}
	}

	return sslmode === 'no-verify' ? 'encrypted' : 'verified';
}

/**
 * Rewrite an external-Postgres connection string so `sslmode` carries its libpq
 * meaning, and report the TLS posture that results.
 *
 * Only the modes that the two readings actually disagree on are touched, and
 * only where opting in is safe:
 *
 * - `prefer` / `require` are opted in - this is the fix.
 * - `verify-ca` is opted in only alongside `sslrootcert`; without one the libpq
 *   branch *throws*, so the string is left to resolve as it does today.
 * - `no-verify` is left alone: it is not a libpq mode, so opting in would fall
 *   through to the verify-everything default and silently re-enable
 *   verification on deployments that work today.
 * - `disable`, `verify-full`, an absent `sslmode`, and an explicit operator
 *   `uselibpqcompat` are all left byte-identical.
 */
export function normalizePostgresUrl(
	raw: string,
	env: Record<string, string | undefined> = process.env,
): NormalizedPostgresUrl {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		// Defensive only - openDatabase rejects non-URL strings before this runs.
		return { url: raw, tls: 'unspecified' };
	}

	// pg-connection-string folds the query by assigning each entry in order, so
	// a repeated param resolves to its LAST occurrence; `get()` returns the first.
	const last = (key: string): string | undefined => {
		const all = parsed.searchParams.getAll(key);
		return all.length > 0 ? all[all.length - 1] : undefined;
	};

	const sslmode = last('sslmode');
	const hasCaFile = last('sslrootcert') !== undefined;
	const hasSslFile = SSL_FILE_PARAMS.some((p) => last(p) !== undefined);
	const posture = (libpq: boolean): PostgresTlsPosture =>
		tlsPosture({ sslmode, hasCaFile, hasSslFile, libpq, pgSslMode: env.PGSSLMODE });

	// An explicit setting either way is the operator's decision. The parser
	// compares against the literal 'true', so anything else selects the legacy
	// reading.
	const explicitCompat = last('uselibpqcompat');
	if (explicitCompat !== undefined) {
		return { url: raw, tls: posture(explicitCompat === 'true') };
	}

	const optIn =
		sslmode === 'prefer' || sslmode === 'require' || (sslmode === 'verify-ca' && hasCaFile);
	if (!optIn) return { url: raw, tls: posture(false) };

	return { url: appendQueryParam(raw, parsed, LIBPQ_COMPAT_PARAM), tls: posture(true) };
}

/**
 * Append to the query without round-tripping through `URL.toString()`, which
 * re-encodes values the operator wrote by hand (a unix-socket `host=/var/run/…`
 * becomes `%2Fvar%2Frun%2F…`, a space in `options=` becomes `+`). A fragment is
 * the one case that needs the round-trip, since a raw append would land the
 * param inside it.
 */
function appendQueryParam(raw: string, parsed: URL, param: string): string {
	if (parsed.hash) {
		const [key, value] = param.split('=');
		parsed.searchParams.set(key, value);
		return parsed.toString();
	}
	// A trailing bare `?` parses to an empty search but already opens the query.
	const separator = parsed.search ? '&' : raw.endsWith('?') ? '' : '?';
	return `${raw}${separator}${param}`;
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
		default:
			return 'TLS unknown';
	}
}

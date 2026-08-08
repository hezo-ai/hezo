import { hostMatchesAllowedHosts } from '@hezo/shared';
import { decrypt } from '../../crypto/encryption';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Db } from '../../db/database';
import { createPlaceholderRegex, PLACEHOLDER_PROBE } from '../../lib/credential-placeholder';
import { refreshExpiringTokens } from '../oauth/token-resolver';

/**
 * Token agents emit in headers, URLs, and (when opted-in) request bodies in
 * place of real secret values. The egress proxy intercepts every outbound
 * request and substitutes these tokens with the matching `secrets.name`
 * before the request leaves the host. Secrets are instance-global, so any
 * run can emit any placeholder (still bounded by each secret's
 * allowed_hosts). Bodies are forwarded unchanged by default; a secret with
 * `allow_body_substitution` may also be substituted into a small JSON request
 * body (gated by the proxy to ≤ 8 KB `application/json` requests) — for APIs
 * that take a credential in the body, such as a login that returns a token.
 *
 * The match grammar is the SINGLE canonical one shared with
 * `request_credential` and the admin secrets route (see
 * `lib/credential-placeholder.ts`): a name the proxy would substitute is
 * exactly a name those paths permit, so a stored secret can never be
 * un-referenceable and a placeholder can never match a name no path could
 * have created. The probe is a non-global literal test (cheap pre-scan);
 * the substitution regex is fresh per call to avoid shared `lastIndex`.
 */
export const PLACEHOLDER_PROBE_REGEX = new RegExp(PLACEHOLDER_PROBE);

export interface SubstitutionScope {
	db: Db;
	masterKeyManager: MasterKeyManager;
}

export interface ResolvedSecret {
	name: string;
	value: string;
	allowedHosts: string[];
	allowAllHosts: boolean;
	allowBodySubstitution: boolean;
}

export type SubstitutionFailure =
	| { kind: 'unknown_secret'; name: string }
	| { kind: 'secret_not_allowed_for_host'; name: string; host: string }
	| { kind: 'secret_not_allowed_in_body'; name: string }
	| { kind: 'secrets_unavailable' };

export interface SubstitutionResult {
	headers: Record<string, string | string[]>;
	url: string;
	body: string | null;
	headersChanged: boolean;
	urlChanged: boolean;
	bodyChanged: boolean;
	secretsUsed: Set<string>;
	failure: SubstitutionFailure | null;
}

interface RequestInputs {
	url: string;
	headers: Record<string, string | string[] | undefined>;
	method: string;
	host: string;
	/** Decoded request body, when the proxy has buffered it for substitution.
	 * Only set for gated requests (small `application/json`); omitted otherwise,
	 * in which case the body is forwarded byte-for-byte and never inspected. */
	body?: string | null;
}

/**
 * Decrypted-vault cache.
 *
 * `loadAllSecrets` runs for every proxied request carrying a placeholder — i.e.
 * every MCP call an agent makes — and used to cost two DB queries plus an
 * AES-256-GCM decrypt of *every* secret in the vault, on the one serialized
 * database handle shared with the rest of the process. At ten concurrent runs
 * that was the single largest per-request cost in the egress path.
 *
 * Invalidation has three layers, deliberately:
 * 1. `invalidateSecretsVault()`, called by every path that writes the `secrets`
 *    table, so an admin's change takes effect on the next request.
 * 2. Clearing on master-key state change (see `bindSecretsVaultToMasterKey`) —
 *    decrypted material must never outlive the unlock that produced it.
 * 3. A short TTL, so a write path that forgets (1) degrades to seconds of
 *    staleness rather than a permanent stale read. A cache whose correctness
 *    rests entirely on every call site remembering to invalidate is a bug
 *    waiting for the next contributor.
 *
 * The values live only in server memory on the proxy path, exactly as they did
 * transiently before; nothing here is reachable from an agent run.
 */
const VAULT_CACHE_TTL_MS = 5_000;

interface VaultCacheEntry {
	secrets: Map<string, ResolvedSecret>;
	loadedAt: number;
}

let vaultCache: VaultCacheEntry | null = null;
let vaultInflight: Promise<Map<string, ResolvedSecret>> | null = null;
/**
 * Bumped by every invalidation. A load captures it before reading and refuses to
 * commit its result if it changed in the meantime.
 *
 * Nulling `vaultCache` alone is not enough once anything invalidates from
 * OUTSIDE this path. A background token refresh that lands while a read is in
 * flight would have its invalidation immediately overwritten by the older
 * snapshot the read then commits, and the proxy would serve a rotated-away token
 * for up to the TTL - intermittent 401s on agent MCP calls with nothing in the
 * log to explain them. That was unreachable while the only refresher ran inside
 * `readAndDecryptVault` itself (before the SELECT); the periodic connector-health
 * sweep made it an ordinary interleaving.
 */
let vaultGeneration = 0;

/** Drop the cached vault. Call after any write to the `secrets` table. */
export function invalidateSecretsVault(): void {
	vaultCache = null;
	vaultGeneration++;
}

/**
 * Clear the vault whenever the master key changes state, so decrypted values
 * never survive a lock or a re-unlock with different key material.
 */
export function bindSecretsVaultToMasterKey(masterKeyManager: MasterKeyManager): void {
	masterKeyManager.onUnlock(() => invalidateSecretsVault());
}

export async function loadAllSecrets(
	scope: SubstitutionScope,
): Promise<Map<string, ResolvedSecret>> {
	const key = scope.masterKeyManager.getKey();
	if (!key) {
		invalidateSecretsVault();
		const err = new Error('LOCKED');
		err.name = 'MasterKeyLocked';
		throw err;
	}

	const cached = vaultCache;
	if (cached && Date.now() - cached.loadedAt < VAULT_CACHE_TTL_MS) return cached.secrets;

	// Coalesce concurrent misses: ten agents hitting the proxy at once would
	// otherwise each run the full read-and-decrypt before any of them caches.
	if (vaultInflight) return vaultInflight;
	const generation = vaultGeneration;
	const load = readAndDecryptVault(scope, key);
	vaultInflight = load;
	try {
		const secrets = await load;
		// Only cache what is still current. When an invalidation raced this read,
		// the caller still gets these values (they are no more stale than what it
		// asked for) but they are not published to the next request.
		if (generation === vaultGeneration) vaultCache = { secrets, loadedAt: Date.now() };
		return secrets;
	} finally {
		if (vaultInflight === load) vaultInflight = null;
	}
}

async function readAndDecryptVault(
	scope: SubstitutionScope,
	key: Buffer,
): Promise<Map<string, ResolvedSecret>> {
	await refreshExpiringTokens({ db: scope.db, masterKeyManager: scope.masterKeyManager });

	// All secrets are instance-global; any run may emit any placeholder, still
	// bounded per-secret by allowed_hosts. `name` is unique, so no dedup needed.
	const result = await scope.db.query<{
		name: string;
		encrypted_value: string;
		allowed_hosts: string[];
		allow_all_hosts: boolean;
		allow_body_substitution: boolean;
	}>(
		`SELECT name, encrypted_value, allowed_hosts, allow_all_hosts, allow_body_substitution
		 FROM secrets`,
	);

	const out = new Map<string, ResolvedSecret>();
	for (const row of result.rows) {
		out.set(row.name, {
			name: row.name,
			value: decrypt(row.encrypted_value, key),
			allowedHosts: row.allowed_hosts ?? [],
			allowAllHosts: row.allow_all_hosts,
			allowBodySubstitution: row.allow_body_substitution ?? false,
		});
	}
	return out;
}

export function substituteRequest(
	input: RequestInputs,
	secrets: Map<string, ResolvedSecret>,
): SubstitutionResult {
	const secretsUsed = new Set<string>();
	const checkAccess = (name: string): SubstitutionFailure | null => {
		const secret = secrets.get(name);
		if (!secret) return { kind: 'unknown_secret', name };
		if (
			!secret.allowAllHosts &&
			(secret.allowedHosts.length === 0 || !hostMatchesAllowlist(input.host, secret.allowedHosts))
		) {
			return { kind: 'secret_not_allowed_for_host', name, host: input.host };
		}
		return null;
	};
	// Body substitution is gated on a per-secret opt-in on top of the host check:
	// a placeholder in the body for a secret without `allow_body_substitution`
	// fails loudly rather than leaking the literal placeholder into the payload.
	const checkBodyAccess = (name: string): SubstitutionFailure | null => {
		const hostFailure = checkAccess(name);
		if (hostFailure) return hostFailure;
		const secret = secrets.get(name);
		if (!secret?.allowBodySubstitution) return { kind: 'secret_not_allowed_in_body', name };
		return null;
	};

	let failure: SubstitutionFailure | null = null;

	const headersOut: Record<string, string | string[]> = {};
	let headersChanged = false;
	for (const [name, raw] of Object.entries(input.headers)) {
		if (raw === undefined) continue;
		if (Array.isArray(raw)) {
			const replaced: string[] = [];
			for (const value of raw) {
				const out = applyToString(value, secrets, secretsUsed, checkAccess);
				if (out.failure) failure ??= out.failure;
				if (out.changed) headersChanged = true;
				replaced.push(out.value);
			}
			headersOut[name] = replaced;
		} else {
			const out =
				name.toLowerCase() === 'authorization'
					? applyToAuthorization(raw, secrets, secretsUsed, checkAccess)
					: applyToString(raw, secrets, secretsUsed, checkAccess);
			if (out.failure) failure ??= out.failure;
			if (out.changed) headersChanged = true;
			headersOut[name] = out.value;
		}
	}

	const urlOut = applyToString(input.url, secrets, secretsUsed, checkAccess);
	if (urlOut.failure) failure ??= urlOut.failure;

	let body: string | null = input.body ?? null;
	let bodyChanged = false;
	if (typeof input.body === 'string') {
		const bodyOut = applyToString(input.body, secrets, secretsUsed, checkBodyAccess);
		if (bodyOut.failure) failure ??= bodyOut.failure;
		body = bodyOut.value;
		bodyChanged = bodyOut.changed;
	}

	return {
		headers: headersOut,
		url: urlOut.value,
		body,
		headersChanged,
		urlChanged: urlOut.changed,
		bodyChanged,
		secretsUsed,
		failure,
	};
}

interface ApplyResult {
	value: string;
	changed: boolean;
	failure: SubstitutionFailure | null;
}

function applyToString(
	input: string,
	secrets: Map<string, ResolvedSecret>,
	secretsUsed: Set<string>,
	checkAccess: (name: string) => SubstitutionFailure | null,
): ApplyResult {
	if (!PLACEHOLDER_PROBE_REGEX.test(input)) {
		return { value: input, changed: false, failure: null };
	}
	let failure: SubstitutionFailure | null = null;
	const result = input.replace(createPlaceholderRegex(), (match, name: string) => {
		const access = checkAccess(name);
		if (access) {
			failure ??= access;
			return match;
		}
		const secret = secrets.get(name);
		if (!secret) {
			failure ??= { kind: 'unknown_secret', name };
			return match;
		}
		secretsUsed.add(name);
		return secret.value;
	});
	return { value: result, changed: result !== input, failure };
}

/**
 * An `Authorization` header, substituting **inside** a `Basic` credential.
 *
 * A placeholder does not always reach the wire as text. Git turns the credential
 * in an HTTPS remote into a base64 Basic header - measured:
 * `https://x-access-token:__HEZO_SECRET_GITHUB_TOKEN__@github.com/…` arrives as
 * `Basic eC1hY2Nlc3MtdG9rZW46X19IRVpPX1NFQ1JFVF9HSVRIVUJfVE9LRU5fXw==`. A
 * literal scan finds nothing there, so every clone, fetch and push would ship the
 * unsubstituted placeholder as its password and be refused by GitHub.
 *
 * Decode, substitute, re-encode. Deliberately generic rather than git-shaped:
 * any API taking a credential through Basic auth gets the same treatment, and
 * nothing here knows what a git remote is.
 *
 * The security properties are unchanged, because this only reaches
 * {@link applyToString}: the same per-secret `allowed_hosts` gate, the same
 * `secretsUsed` accounting, the same failure kinds. A value that is not Basic, or
 * not valid base64, or carries no placeholder, is passed to the ordinary
 * literal path so a bearer token or a hand-written header behaves exactly as
 * before.
 */
function applyToAuthorization(
	raw: string,
	secrets: Map<string, ResolvedSecret>,
	secretsUsed: Set<string>,
	checkAccess: (name: string) => SubstitutionFailure | null,
): ApplyResult {
	const basic = decodeBasicCredential(raw);
	// Not Basic, not valid base64, or carrying no placeholder: the ordinary
	// literal path, so a bearer token or a hand-written header behaves exactly as
	// before. Re-encoding a value that round-trips differently would corrupt a
	// credential that never carried a placeholder in the first place.
	if (!basic) return applyToString(raw, secrets, secretsUsed, checkAccess);

	const out = applyToString(basic.decoded, secrets, secretsUsed, checkAccess);
	if (!out.changed) return { value: raw, changed: false, failure: out.failure };
	return {
		value: `${basic.prefix}${Buffer.from(out.value, 'utf8').toString('base64')}`,
		changed: true,
		failure: out.failure,
	};
}

/**
 * The base64 inside a `Basic` credential, **only** when it carries a placeholder.
 *
 * Two callers need this and they must agree, which is why it is one function
 * rather than two copies of the same regex. `applyToAuthorization` needs the
 * decoded text to substitute into; the proxy's cheap pre-flight scan needs to
 * know that a header carries a placeholder *at all*, and its literal scan cannot
 * see through base64 - so a disagreement means the proxy skips substitution
 * entirely for exactly the credential shape this path exists to handle. It did:
 * `applyToAuthorization` was correct and unreachable, because the gate above it
 * looked at the header verbatim and found nothing.
 *
 * Returns null for anything that is not a placeholder-carrying Basic value, so
 * both callers fall back to their ordinary literal behaviour.
 */
export function decodeBasicCredential(raw: string): { prefix: string; decoded: string } | null {
	const match = /^(\s*Basic\s+)([A-Za-z0-9+/=]+)\s*$/i.exec(raw);
	if (!match) return null;
	let decoded: string;
	try {
		decoded = Buffer.from(match[2], 'base64').toString('utf8');
	} catch {
		return null;
	}
	if (!PLACEHOLDER_PROBE_REGEX.test(decoded)) return null;
	return { prefix: match[1], decoded };
}

/**
 * Whether a header value carries a placeholder, **including** one hidden inside a
 * base64 Basic credential. The proxy gates all substitution on this, so it has to
 * see everything {@link substituteRequest} would act on.
 */
export function headerValueCarriesPlaceholder(name: string, value: string): boolean {
	if (PLACEHOLDER_PROBE_REGEX.test(value)) return true;
	return name.toLowerCase() === 'authorization' && decodeBasicCredential(value) !== null;
}

/**
 * Delegated to `@hezo/shared` so the *substitute here?* answer and the tunnel's
 * *route through the proxy?* answer come from one definition. They had drifted:
 * this one reads `*.example.com`, the tunnel's read `.example.com`, and a
 * wildcard-scoped secret was therefore routed direct and never substituted.
 */
function hostMatchesAllowlist(host: string, allowedHosts: string[]): boolean {
	return hostMatchesAllowedHosts(host, allowedHosts);
}

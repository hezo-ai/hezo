import { logger } from '../../logger';

const log = logger.child('image-ref');

/**
 * Resolving a container image tag to its immutable digest.
 *
 * Nothing here is provider-specific - it is the standard OCI distribution
 * (registry v2) manifest lookup - but the reason Hezo needs it is:
 *
 * Docker resolves a tag itself on every pull, and Hezo already re-pulls
 * `:latest` each boot to pick up a new release. A managed sandbox service has
 * no such step. Daytona builds a sandbox from **Dockerfile text** and keys its
 * build cache on a hash of that text, so `FROM …:latest` is byte-identical
 * forever: the cache key never moves, and the provider keeps serving the
 * snapshot it built the first time. Agents would silently run an old toolchain
 * with nothing anywhere to surface it.
 *
 * Pinning the digest is what makes that cache correct - a new release changes
 * the digest, which changes the Dockerfile text, which changes the cache key.
 */

/** How long a resolved digest is trusted before it is looked up again. */
const CACHE_TTL_MS = 10 * 60_000;

/**
 * Cap on the digest cache. Keyed by image reference, of which an instance has
 * very few (the shipped agent-base plus any per-project `docker_base_image`),
 * so this is a runaway guard rather than a working limit. Entries also expire
 * on the TTL above, so the cache cannot serve a stale digest indefinitely.
 */
const CACHE_MAX = 64;

const cache = new Map<string, { ref: string; expiresAt: number }>();

/** Manifest types to accept, widest first - a multi-arch index is the normal case. */
const MANIFEST_ACCEPT = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json',
].join(',');

const REGISTRY_TIMEOUT_MS = 15_000;

export interface ParsedImageRef {
	registry: string;
	/** Repository path as the registry API wants it, e.g. `hezo-ai/agent-base`. */
	repository: string;
	tag: string;
	/** Present when the reference was already digest-pinned. */
	digest?: string;
}

/**
 * Split an image reference into registry, repository and tag/digest.
 *
 * The awkward case is telling a registry host from the first path segment:
 * `hezo/agent-base` is Docker Hub's `library`-adjacent form, while
 * `ghcr.io/hezo-ai/agent-base` names a host. A dot, a colon or the literal
 * `localhost` in the first segment is the conventional signal, and it is what
 * every registry client uses.
 */
export function parseImageRef(ref: string): ParsedImageRef {
	const at = ref.indexOf('@');
	const digest = at === -1 ? undefined : ref.slice(at + 1);
	const withoutDigest = at === -1 ? ref : ref.slice(0, at);

	const slash = withoutDigest.indexOf('/');
	const first = slash === -1 ? '' : withoutDigest.slice(0, slash);
	const hasHost = first.includes('.') || first.includes(':') || first === 'localhost';
	const registry = hasHost ? first : 'docker.io';
	let remainder = hasHost ? withoutDigest.slice(slash + 1) : withoutDigest;

	// A colon after the last slash is the tag; one before it is a host port.
	const lastSlash = remainder.lastIndexOf('/');
	const colon = remainder.indexOf(':', lastSlash + 1);
	let tag = 'latest';
	if (colon !== -1) {
		tag = remainder.slice(colon + 1);
		remainder = remainder.slice(0, colon);
	}
	// Docker Hub's official images live under `library/`.
	const repository =
		registry === 'docker.io' && !remainder.includes('/') ? `library/${remainder}` : remainder;

	return { registry, repository, tag, digest };
}

/** `<registry>/<repository>@<digest>`, in the form a `FROM` line takes. */
function pinnedRef(parsed: ParsedImageRef, digest: string): string {
	const host = parsed.registry === 'docker.io' ? 'docker.io' : parsed.registry;
	return `${host}/${parsed.repository}@${digest}`;
}

/**
 * Resolve `ref` to a digest-pinned reference, or return it unchanged when that
 * is not possible.
 *
 * **Falls back rather than failing.** An image on a private registry, an
 * offline instance, or a locally-built tag that exists in no registry at all
 * cannot be resolved - and refusing to start a container over a cache-freshness
 * concern would break a setup that otherwise works. The fallback is logged with
 * what it costs, because the failure it re-admits is otherwise invisible.
 */
export async function resolveDigestPinnedRef(ref: string): Promise<string> {
	const parsed = parseImageRef(ref);
	if (parsed.digest) return ref;

	const now = Date.now();
	const hit = cache.get(ref);
	if (hit && hit.expiresAt > now) return hit.ref;

	try {
		const digest = await fetchManifestDigest(parsed);
		if (!digest) throw new Error('registry returned no digest');
		const resolved = pinnedRef(parsed, digest);
		if (cache.size >= CACHE_MAX) {
			const oldest = cache.keys().next();
			if (!oldest.done) cache.delete(oldest.value);
		}
		cache.set(ref, { ref: resolved, expiresAt: now + CACHE_TTL_MS });
		return resolved;
	} catch (e) {
		log.warn(
			`Could not resolve ${ref} to a digest (${(e as Error).message}). ` +
				'Falling back to the tag - a managed sandbox backend caches its build on the ' +
				'reference text, so it may keep serving an already-built image after a new ' +
				'release rather than picking the new one up.',
		);
		return ref;
	}
}

/** Test hook: the cache is process-lifetime otherwise, which would leak between cases. */
export function clearImageDigestCache(): void {
	cache.clear();
}

/**
 * HEAD the manifest and read `Docker-Content-Digest`.
 *
 * HEAD rather than GET because the digest is a header - the body is the whole
 * manifest and is never needed. A registry that wants auth answers 401 with a
 * `WWW-Authenticate: Bearer` challenge naming a token endpoint; fetching an
 * anonymous token from it and retrying is the standard flow, and is what makes
 * this work against a public GHCR or Docker Hub image with no credentials.
 */
async function fetchManifestDigest(parsed: ParsedImageRef): Promise<string | null> {
	const host = parsed.registry === 'docker.io' ? 'registry-1.docker.io' : parsed.registry;
	const url = `https://${host}/v2/${parsed.repository}/manifests/${encodeURIComponent(parsed.tag)}`;
	const headers: Record<string, string> = { Accept: MANIFEST_ACCEPT };

	let res = await fetch(url, {
		method: 'HEAD',
		headers,
		signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
	});
	if (res.status === 401) {
		const token = await fetchAnonymousToken(res.headers.get('www-authenticate'));
		if (!token) throw new Error('registry requires credentials');
		headers.Authorization = `Bearer ${token}`;
		res = await fetch(url, {
			method: 'HEAD',
			headers,
			signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
		});
	}
	if (!res.ok) throw new Error(`registry answered ${res.status}`);
	return res.headers.get('docker-content-digest');
}

/**
 * Exchange a `WWW-Authenticate: Bearer realm="…",service="…",scope="…"`
 * challenge for an anonymous pull token. Returns null when the challenge names
 * no realm, which means there is no anonymous path in.
 */
export async function fetchAnonymousToken(challenge: string | null): Promise<string | null> {
	if (!challenge) return null;
	const params = new Map<string, string>();
	for (const m of challenge.matchAll(/(\w+)="([^"]*)"/g)) params.set(m[1], m[2]);
	const realm = params.get('realm');
	if (!realm) return null;

	const url = new URL(realm);
	for (const key of ['service', 'scope']) {
		const value = params.get(key);
		if (value) url.searchParams.set(key, value);
	}
	const res = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
	if (!res.ok) return null;
	const body = (await res.json()) as { token?: string; access_token?: string };
	return body.token ?? body.access_token ?? null;
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	clearImageDigestCache,
	fetchAnonymousToken,
	parseImageRef,
	resolveDigestPinnedRef,
} from '../src/services/sandbox/image-ref';

const DIGEST = 'sha256:c571976834e5ad497e3393231a83dd7a949f9218622812ff998cabb1f699f627';

afterEach(() => {
	clearImageDigestCache();
	vi.restoreAllMocks();
});

/** A registry that answers a HEAD manifest with the digest header. */
function stubRegistry(opts: { status?: number; digest?: string | null; challenge?: string } = {}) {
	const calls: string[] = [];
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		calls.push(url);
		if (url.includes('/token')) {
			return new Response(JSON.stringify({ token: 'anon-token' }), { status: 200 });
		}
		if (opts.challenge && init?.headers && !('Authorization' in (init.headers as object))) {
			return new Response(null, {
				status: 401,
				headers: { 'www-authenticate': opts.challenge },
			});
		}
		const headers = new Headers();
		const digest = opts.digest === undefined ? DIGEST : opts.digest;
		if (digest) headers.set('docker-content-digest', digest);
		return new Response(null, { status: opts.status ?? 200, headers });
	});
	vi.stubGlobal('fetch', fetchMock);
	return { calls, fetchMock };
}

describe('parseImageRef', () => {
	it.each([
		['ghcr.io/hezo-ai/agent-base:latest', 'ghcr.io', 'hezo-ai/agent-base', 'latest'],
		['ghcr.io/hezo-ai/agent-base', 'ghcr.io', 'hezo-ai/agent-base', 'latest'],
		['hezo/agent-base:v2', 'docker.io', 'hezo/agent-base', 'v2'],
		// A bare name is a Docker Hub official image, which lives under `library/`.
		['ubuntu:24.04', 'docker.io', 'library/ubuntu', '24.04'],
		// A port in the host must not be mistaken for a tag.
		['registry.internal:5000/team/img:dev', 'registry.internal:5000', 'team/img', 'dev'],
	])('parses %s', (ref, registry, repository, tag) => {
		expect(parseImageRef(ref)).toMatchObject({ registry, repository, tag });
	});

	it('recognizes an already-pinned reference', () => {
		const parsed = parseImageRef(`ghcr.io/hezo-ai/agent-base@${DIGEST}`);
		expect(parsed.digest).toBe(DIGEST);
		expect(parsed.repository).toBe('hezo-ai/agent-base');
	});
});

/**
 * Why this exists at all: Daytona builds a sandbox from Dockerfile *text* and
 * caches on a hash of it, so `FROM …:latest` is byte-identical forever - the
 * cache key never moves and the provider keeps serving the image it first
 * built. Agents would silently run an old toolchain with nothing to surface it.
 */
describe('resolveDigestPinnedRef', () => {
	it('pins a tag to its digest', async () => {
		stubRegistry();
		expect(await resolveDigestPinnedRef('ghcr.io/hezo-ai/agent-base:latest')).toBe(
			`ghcr.io/hezo-ai/agent-base@${DIGEST}`,
		);
	});

	it('leaves an already-pinned reference alone and makes no request', async () => {
		const { fetchMock } = stubRegistry();
		const ref = `ghcr.io/hezo-ai/agent-base@${DIGEST}`;
		expect(await resolveDigestPinnedRef(ref)).toBe(ref);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('exchanges a bearer challenge for an anonymous token and retries', async () => {
		// The flow that makes a public GHCR image resolvable with no credentials.
		const { calls } = stubRegistry({
			challenge:
				'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:hezo-ai/agent-base:pull"',
		});
		expect(await resolveDigestPinnedRef('ghcr.io/hezo-ai/agent-base:latest')).toContain(DIGEST);
		expect(calls.some((u) => u.includes('/token') && u.includes('scope='))).toBe(true);
	});

	it('caches, so a second create does not re-query the registry', async () => {
		const { fetchMock } = stubRegistry();
		await resolveDigestPinnedRef('ghcr.io/hezo-ai/agent-base:latest');
		await resolveDigestPinnedRef('ghcr.io/hezo-ai/agent-base:latest');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('falls back to the tag when the registry is unreachable', async () => {
		// An offline instance, a private registry, or a locally-built tag that
		// exists in no registry. Refusing to start a container over a
		// cache-freshness concern would break a setup that otherwise works.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('ENOTFOUND');
			}),
		);
		expect(await resolveDigestPinnedRef('ghcr.io/hezo-ai/agent-base:latest')).toBe(
			'ghcr.io/hezo-ai/agent-base:latest',
		);
	});

	it('falls back when the registry answers without a digest header', async () => {
		stubRegistry({ digest: null });
		expect(await resolveDigestPinnedRef('ghcr.io/hezo-ai/agent-base:latest')).toBe(
			'ghcr.io/hezo-ai/agent-base:latest',
		);
	});

	it('falls back on a non-OK response', async () => {
		stubRegistry({ status: 404 });
		expect(await resolveDigestPinnedRef('ghcr.io/private/img:latest')).toBe(
			'ghcr.io/private/img:latest',
		);
	});

	it('does not cache a failure, so a transient outage self-heals', async () => {
		let fail = true;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				if (fail) throw new Error('transient');
				const headers = new Headers({ 'docker-content-digest': DIGEST });
				return new Response(null, { status: 200, headers });
			}),
		);
		expect(await resolveDigestPinnedRef('ghcr.io/hezo-ai/agent-base:latest')).not.toContain('@');
		fail = false;
		expect(await resolveDigestPinnedRef('ghcr.io/hezo-ai/agent-base:latest')).toContain(DIGEST);
	});
});

describe('fetchAnonymousToken', () => {
	it('returns null when there is no challenge at all', async () => {
		expect(await fetchAnonymousToken(null)).toBeNull();
	});

	it('returns null when the challenge names no realm, so there is no way in', async () => {
		expect(await fetchAnonymousToken('Basic realmless')).toBeNull();
	});
});

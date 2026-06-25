import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	downloadSkillContent,
	SkillDownloadError,
	syncSkillFromUrl,
} from '../src/services/skill-downloader';

// Drives downloadSkillContent / syncSkillFromUrl by stubbing the global fetch.
// No real network is touched.

const realFetch = globalThis.fetch;
const realNodeEnv = process.env.NODE_ENV;

function mockResponse(opts: {
	ok?: boolean;
	status?: number;
	contentLength?: string | null;
	body?: string;
}): Response {
	const body = opts.body ?? '';
	const headers = new Headers();
	if (opts.contentLength !== null && opts.contentLength !== undefined) {
		headers.set('content-length', opts.contentLength);
	}
	return {
		ok: opts.ok ?? true,
		status: opts.status ?? 200,
		headers,
		arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
	} as unknown as Response;
}

afterEach(() => {
	globalThis.fetch = realFetch;
	if (realNodeEnv === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = realNodeEnv;
	vi.restoreAllMocks();
});

describe('downloadSkillContent — happy path', () => {
	it('fetches content and returns the sha256 hash', async () => {
		const content = '# A skill\n\nbody text';
		const fetchMock = vi.fn(async () => mockResponse({ body: content }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await downloadSkillContent('https://example.com/skill.md');
		expect(result.content).toBe(content);
		expect(result.hash).toBe(createHash('sha256').update(content).digest('hex'));
		// The resolved URL is passed straight through for a non-github host.
		expect(fetchMock).toHaveBeenCalledWith(
			'https://example.com/skill.md',
			expect.objectContaining({ redirect: 'follow' }),
		);
	});

	it('resolves a github.com blob URL to raw.githubusercontent.com before fetching', async () => {
		const fetchMock = vi.fn(async () => mockResponse({ body: 'x' }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await downloadSkillContent('https://github.com/owner/repo/blob/main/skills/x.md');
		expect(fetchMock).toHaveBeenCalledWith(
			'https://raw.githubusercontent.com/owner/repo/main/skills/x.md',
			expect.anything(),
		);
	});

	it('syncSkillFromUrl delegates to downloadSkillContent', async () => {
		const fetchMock = vi.fn(async () => mockResponse({ body: 'sync-body' }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await syncSkillFromUrl('https://example.com/skill.md');
		expect(result.content).toBe('sync-body');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('downloadSkillContent — scheme enforcement', () => {
	it('rejects an http URL in production with forbidden_scheme', async () => {
		process.env.NODE_ENV = 'production';
		const fetchMock = vi.fn(async () => mockResponse({ body: 'x' }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await expect(downloadSkillContent('http://example.com/skill.md')).rejects.toMatchObject({
			reason: 'forbidden_scheme',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('allows an http URL outside production', async () => {
		process.env.NODE_ENV = 'test';
		const fetchMock = vi.fn(async () => mockResponse({ body: 'ok' }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await downloadSkillContent('http://example.com/skill.md');
		expect(result.content).toBe('ok');
	});

	it('rejects a non-http(s) scheme', async () => {
		const fetchMock = vi.fn(async () => mockResponse({ body: 'x' }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		await expect(downloadSkillContent('ftp://example.com/skill.md')).rejects.toMatchObject({
			reason: 'forbidden_scheme',
		});
	});
});

describe('downloadSkillContent — error paths', () => {
	it('maps a 404 response to not_found', async () => {
		globalThis.fetch = vi.fn(async () =>
			mockResponse({ ok: false, status: 404 }),
		) as unknown as typeof fetch;
		await expect(downloadSkillContent('https://example.com/missing.md')).rejects.toMatchObject({
			reason: 'not_found',
		});
	});

	it('maps a non-404 error status to network', async () => {
		globalThis.fetch = vi.fn(async () =>
			mockResponse({ ok: false, status: 500 }),
		) as unknown as typeof fetch;
		await expect(downloadSkillContent('https://example.com/boom.md')).rejects.toMatchObject({
			reason: 'network',
		});
	});

	it('maps a thrown network error to network', async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error('connection refused');
		}) as unknown as typeof fetch;
		const err = await downloadSkillContent('https://example.com/x.md').catch((e) => e);
		expect(err).toBeInstanceOf(SkillDownloadError);
		expect(err.reason).toBe('network');
		expect(err.message).toContain('connection refused');
	});

	it('maps an AbortError to timeout', async () => {
		globalThis.fetch = vi.fn(async () => {
			const e = new Error('aborted');
			e.name = 'AbortError';
			throw e;
		}) as unknown as typeof fetch;
		await expect(downloadSkillContent('https://example.com/slow.md')).rejects.toMatchObject({
			reason: 'timeout',
		});
	});

	it('rejects when content-length header exceeds the size cap', async () => {
		globalThis.fetch = vi.fn(async () =>
			mockResponse({ contentLength: String(512 * 1024 + 1), body: 'small' }),
		) as unknown as typeof fetch;
		await expect(downloadSkillContent('https://example.com/big.md')).rejects.toMatchObject({
			reason: 'too_large',
		});
	});

	it('rejects when the actual body exceeds the size cap despite no/short content-length', async () => {
		const big = 'a'.repeat(512 * 1024 + 10);
		globalThis.fetch = vi.fn(async () =>
			mockResponse({ contentLength: null, body: big }),
		) as unknown as typeof fetch;
		await expect(downloadSkillContent('https://example.com/sneaky.md')).rejects.toMatchObject({
			reason: 'too_large',
		});
	});

	it('rejects an unparseable URL before fetching (invalid_url)', async () => {
		const fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		await expect(downloadSkillContent('not a url')).rejects.toMatchObject({
			reason: 'invalid_url',
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

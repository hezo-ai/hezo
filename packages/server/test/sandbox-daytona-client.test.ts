import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaytonaApiError, DaytonaClient } from '../src/services/sandbox/daytona/client';

/**
 * The HTTP client, against a scripted `fetch`.
 *
 * The engine's tests drive a fake `DaytonaApi`, so everything below this - the
 * request the client actually sends, and what it does with the response - was
 * unexercised. Both bugs these cover live exactly there: a paginated list read
 * as a single page, and a session created per streaming exec and never deleted.
 * Neither fails; the first under-reports the fleet and the second accumulates
 * shells inside a container the pool keeps for hours.
 */

const BASE = 'https://app.daytona.io/api';

afterEach(() => vi.restoreAllMocks());

/** Reply to each call in order; the last entry repeats. */
function scriptFetch(replies: Array<{ status?: number; body: unknown }>): {
	calls: Array<{ url: string; method: string }>;
} {
	const calls: Array<{ url: string; method: string }> = [];
	let i = 0;
	vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		calls.push({ url, method: init?.method ?? 'GET' });
		const reply = replies[Math.min(i, replies.length - 1)];
		i += 1;
		return new Response(JSON.stringify(reply.body), {
			status: reply.status ?? 200,
			headers: { 'content-type': 'application/json' },
		});
	});
	return { calls };
}

const sandbox = {
	id: 'sbx-1',
	state: 'started' as const,
	toolboxProxyUrl: 'https://proxy.test/toolbox',
};

describe('listSandboxes follows the cursor', () => {
	it('returns every page, not just the first', async () => {
		// Measured against the live API: `GET /sandbox` answers
		// `{items, nextCursor}` and takes a `cursor` query parameter (a bad value
		// returns "Invalid cursor provided"). Reading page one only meant the orphan
		// reaper swept a page and reported success while the rest kept billing.
		const { calls } = scriptFetch([
			{ body: { items: [{ id: 'a', state: 'started' }], nextCursor: 'c1' } },
			{ body: { items: [{ id: 'b', state: 'started' }], nextCursor: 'c2' } },
			{ body: { items: [{ id: 'c', state: 'started' }], nextCursor: null } },
		]);
		const { items } = await new DaytonaClient('k', BASE).listSandboxes();
		expect(items.map((s) => s.id)).toEqual(['a', 'b', 'c']);
		expect(calls).toHaveLength(3);
		expect(calls[1].url).toContain('cursor=c1');
		expect(calls[2].url).toContain('cursor=c2');
	});

	it('carries the label filter onto every page', async () => {
		// Dropping it after page one would sweep sandboxes belonging to another
		// instance sharing the account.
		const { calls } = scriptFetch([
			{ body: { items: [], nextCursor: 'c1' } },
			{ body: { items: [], nextCursor: null } },
		]);
		await new DaytonaClient('k', BASE).listSandboxes({ 'hezo.instance': 'abc' });
		for (const call of calls) expect(call.url).toContain('labels=');
		expect(calls[1].url).toContain('cursor=c1');
	});

	it('stops at a bounded page count rather than spinning on a cursor that never ends', async () => {
		const warn = vi.spyOn(console, 'log').mockImplementation(() => {});
		scriptFetch([{ body: { items: [{ id: 'x', state: 'started' }], nextCursor: 'always' } }]);
		const { items } = await new DaytonaClient('k', BASE).listSandboxes();
		expect(items.length).toBeGreaterThan(0);
		// And it says so - a sweep that silently covered part of the fleet reads
		// exactly like one that covered all of it.
		expect(warn.mock.calls.some((c) => String(c[0]).includes('keep billing'))).toBe(true);
	});

	it('makes exactly one request when there is nothing more to fetch', async () => {
		const { calls } = scriptFetch([{ body: { items: [], nextCursor: null } }]);
		await new DaytonaClient('k', BASE).listSandboxes();
		expect(calls).toHaveLength(1);
		expect(calls[0].url).not.toContain('cursor=');
	});
});

describe('executeStreaming does not leak its session', () => {
	/** The exec triad: create session, start async, follow logs, read exit code. */
	function scriptExec(opts: { exitCode?: number; failLogs?: boolean } = {}) {
		const calls: Array<{ url: string; method: string }> = [];
		vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input.toString();
			const method = init?.method ?? 'GET';
			calls.push({ url, method });
			if (url.endsWith('/exec')) return Response.json({ cmdId: 'cmd-1' });
			if (url.includes('/logs')) {
				if (opts.failLogs) throw new Error('stream died');
				return new Response('one\ntwo\n');
			}
			if (url.includes('/command/cmd-1')) return Response.json({ exitCode: opts.exitCode ?? 0 });
			return Response.json({});
		});
		return calls;
	}

	it('deletes the session after a command completes', async () => {
		// A session is a shell that outlives its command, and this is the call every
		// agent run, git operation and chat turn goes through.
		const calls = scriptExec();
		const lines: string[] = [];
		const { exitCode } = await new DaytonaClient('k', BASE).executeStreaming(
			sandbox,
			'echo hi',
			(l) => {
				lines.push(l);
			},
		);
		expect(exitCode).toBe(0);
		expect(lines).toEqual(['one\n', 'two\n']);
		const deletes = calls.filter((c) => c.method === 'DELETE');
		expect(deletes).toHaveLength(1);
		expect(deletes[0].url).toContain('/process/session/hezo-');
	});

	it('deletes the session even when the command stream fails', async () => {
		// The path that actually leaks in production - a clean run is the easy case.
		const calls = scriptExec({ failLogs: true });
		await expect(
			new DaytonaClient('k', BASE).executeStreaming(sandbox, 'echo hi', () => {}),
		).rejects.toThrow();
		expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
	});

	it('reports a session that could not be created rather than failing one step later', async () => {
		vi.stubGlobal('fetch', async () => new Response('over quota', { status: 429 }));
		const err = await new DaytonaClient('k', BASE)
			.executeStreaming(sandbox, 'echo hi', () => {})
			.catch((e) => e);
		expect(err).toBeInstanceOf(DaytonaApiError);
		// Not "returned no cmdId", which is what a swallowed create looked like.
		expect(err.message).toContain('session create failed');
		expect(err.message).toContain('429');
	});

	it('gives each exec its own session id', async () => {
		// A fixed or colliding id would have two concurrent runs sharing one shell,
		// and the first to finish would delete it out from under the second.
		const seen = new Set<string>();
		for (let i = 0; i < 5; i++) {
			const calls = scriptExec();
			await new DaytonaClient('k', BASE).executeStreaming(sandbox, 'echo hi', () => {});
			const id = calls
				.find((c) => c.url.includes('/exec'))
				?.url.match(/\/process\/session\/([^/]+)\/exec/)?.[1];
			expect(id).toBeDefined();
			seen.add(id as string);
		}
		expect(seen.size).toBe(5);
	});
});

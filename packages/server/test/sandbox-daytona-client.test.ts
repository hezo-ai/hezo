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

/**
 * A stand-in for the PTY WebSocket, complete enough that `openPty` completes its
 * real handshake against it.
 *
 * It echoes the sentinel back out of the launch line it is sent, which is what
 * makes the handshake settle - so the object under test runs its actual code
 * path rather than a shortened one.
 */
class FakePtySocket {
	static last: FakePtySocket | undefined;
	binaryType = '';
	bufferedAmount = 0;
	onopen?: () => void;
	onerror?: () => void;
	onclose?: () => void;
	onmessage?: (event: { data: ArrayBuffer | string }) => void;
	/** Binary frames written after the handshake - i.e. what the tunnel sent. */
	readonly sent: Uint8Array[] = [];

	constructor() {
		FakePtySocket.last = this;
		queueMicrotask(() => this.onopen?.());
	}

	send(data: string | Uint8Array): void {
		if (typeof data === 'string') {
			// The launch line. Its sentinel is printed from two halves precisely so
			// the echoed command line does not contain it contiguously; reassemble
			// and hand it back the way a real PTY's output would.
			const m = data.match(/printf '%s%s' '([^']*)' '([^']*)'/);
			if (!m) throw new Error(`launch line carried no sentinel: ${data}`);
			const bytes = new TextEncoder().encode(m[1] + m[2]);
			queueMicrotask(() => this.onmessage?.({ data: bytes.buffer.slice(0) as ArrayBuffer }));
			return;
		}
		this.sent.push(new Uint8Array(data));
	}

	close(): void {
		this.onclose?.();
	}
	ping(): void {}
}

describe('openPty keeps its writes inside what a PTY can take', () => {
	/** Every request answers 200; only the socket matters here. */
	function stubTransport(): void {
		vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('WebSocket', FakePtySocket);
	}

	function joined(chunks: Uint8Array[]): Uint8Array {
		const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
		let at = 0;
		for (const c of chunks) {
			out.set(c, at);
			at += c.byteLength;
		}
		return out;
	}

	it('splits a frame-sized write into PTY-sized messages, in order', async () => {
		// The regression this exists for. The tunnel's framing caps a payload at
		// 64 KiB on every backend, but this transport ends at a terminal whose input
		// queue is 4 KiB - hand it a 64 KiB message and the channel closes. Live, a
		// run died ~150ms after Hezo answered `tools/list`, i.e. while the catalogue
		// was travelling back, leaving the agent with a server it had been told was
		// connected and no tools from it.
		//
		// Asserted here as well as in `chunkPtyPayload`'s own tests because this is
		// the seam a refactor can bypass: the pure function can stay perfect while
		// `send` stops calling it.
		stubTransport();
		const pty = await new DaytonaClient('k', BASE).openPty(sandbox, 'sess-1', 'hezo-tunnel /c');
		const socket = FakePtySocket.last;
		expect(socket).toBeDefined();

		const payload = new Uint8Array(64 * 1024);
		for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
		pty.send(payload);

		await vi.waitFor(() => expect(joined(socket?.sent ?? []).byteLength).toBe(payload.byteLength));
		// Every message within the terminal's bound...
		for (const chunk of socket?.sent ?? []) expect(chunk.byteLength).toBeLessThanOrEqual(4096);
		// ...and the bytes reassemble exactly, because a framed protocol rides this
		// and a dropped or reordered byte desynchronises the decoder.
		expect(joined(socket?.sent ?? [])).toEqual(payload);
	});

	it('preserves order across separate writes', async () => {
		// `send` is paced, so it is no longer synchronous. Two writes that raced
		// would interleave their chunks and tear the tunnel down on a framing error
		// - a failure that only shows up under load, which is the worst kind.
		stubTransport();
		const pty = await new DaytonaClient('k', BASE).openPty(sandbox, 'sess-2', 'hezo-tunnel /c');
		const socket = FakePtySocket.last;

		const first = new Uint8Array(10_000).fill(1);
		const second = new Uint8Array(5_000).fill(2);
		pty.send(first);
		pty.send(second);

		await vi.waitFor(() => expect(joined(socket?.sent ?? []).byteLength).toBe(15_000));
		const all = joined(socket?.sent ?? []);
		expect(all.slice(0, 10_000).every((b) => b === 1)).toBe(true);
		expect(all.slice(10_000).every((b) => b === 2)).toBe(true);
	});
});

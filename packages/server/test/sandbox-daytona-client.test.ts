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

/**
 * Reply to each call in order; the last entry repeats.
 *
 * `raw` sends the string as-is instead of JSON, which is how a gateway failure
 * actually arrives - an HTML error page rather than the API's own shape.
 */
function scriptFetch(replies: Array<{ status?: number; body?: unknown; raw?: string }>): {
	calls: Array<{ url: string; method: string }>;
} {
	const calls: Array<{ url: string; method: string }> = [];
	let i = 0;
	vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		calls.push({ url, method: init?.method ?? 'GET' });
		const reply = replies[Math.min(i, replies.length - 1)];
		i += 1;
		if (reply.raw !== undefined) {
			return new Response(reply.raw, {
				status: reply.status ?? 200,
				headers: { 'content-type': 'text/html' },
			});
		}
		return new Response(JSON.stringify(reply.body), {
			status: reply.status ?? 200,
			headers: { 'content-type': 'application/json' },
		});
	});
	return { calls };
}

/**
 * A client whose retries don't sleep. The backoff itself is not what these
 * specs are about, and paying it in every one of them would add seconds.
 */
function client(retryDelaysMs: number[] = [0, 0, 0]) {
	return new DaytonaClient('k', BASE, { retryDelaysMs });
}

/** What Daytona's front door actually returns when it cannot reach the service. */
const GATEWAY_502 =
	'<html>\n<head><title>502 Bad Gateway</title></head>\n' +
	'<body>\n<center><h1>502 Bad Gateway</h1></center>\n</body>\n</html>\n';

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

	it('resumes a dropped log stream exactly where it left off', async () => {
		// Measured against the live API, and the reason the resume is done here
		// rather than with a request parameter: the endpoint accepts `?offset`,
		// `?from`, `?since`, `?tail` and a `Range:` header and *silently ignores*
		// every one, and a reopened follow stream replays from the first byte. So a
		// naive reconnect duplicates the whole log - double-counted token usage and
		// a re-emitted final message. The client skips what it already delivered.
		let attempt = 0;
		vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (url.endsWith('/exec')) return Response.json({ cmdId: 'cmd-1' });
			if (url.includes('/logs')) {
				attempt += 1;
				if (attempt === 1) {
					// Two whole lines, then the peer closes mid-command. The error has to
					// land on a *later* pull than the data, or the reader never sees the
					// bytes and the test would pass with no resume logic at all.
					let pulls = 0;
					return new Response(
						new ReadableStream({
							pull(c) {
								pulls += 1;
								if (pulls === 1) {
									c.enqueue(new TextEncoder().encode('one\ntwo\n'));
									return;
								}
								c.error(new Error('socket closed unexpectedly'));
							},
						}),
					);
				}
				// The replay: from byte 0, as the provider really does it.
				return new Response('one\ntwo\nthree\nfour\n');
			}
			if (url.includes('/command/cmd-1')) return Response.json({ exitCode: 0 });
			void init;
			return Response.json({});
		});

		const lines: string[] = [];
		const { exitCode } = await new DaytonaClient('k', BASE).executeStreaming(
			sandbox,
			'echo hi',
			(l) => {
				lines.push(l);
			},
		);

		expect(exitCode).toBe(0);
		// Each line exactly once, in order - no gap at the drop, no duplicate from
		// the replay.
		expect(lines).toEqual(['one\n', 'two\n', 'three\n', 'four\n']);
		expect(attempt).toBe(2);
	});

	it('gives up on a stream that will not stay open, naming the transport', async () => {
		// Every reconnect replays the whole log, so an endlessly-failing provider
		// has to stop costing more for less. The error names the channel rather
		// than leaving Bun's "socket connection was closed unexpectedly", which
		// identifies none of the several sockets a run holds.
		vi.stubGlobal('fetch', async (input: string | URL | Request) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (url.endsWith('/exec')) return Response.json({ cmdId: 'cmd-1' });
			if (url.includes('/logs')) {
				return new Response(
					new ReadableStream({
						start(c) {
							c.error(new Error('socket closed unexpectedly'));
						},
					}),
				);
			}
			return Response.json({});
		});

		await expect(
			new DaytonaClient('k', BASE).executeStreaming(sandbox, 'echo hi', () => {}),
		).rejects.toThrow(/output stream .* closed before the command finished/);
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
		const err = await client()
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
 * Daytona's front door answers a bare nginx `502 Bad Gateway` from time to time.
 * Before this the first non-2xx was final everywhere, so one blip during a
 * create settle, a resume or a run's exec killed the whole operation - while the
 * container sync, the single caller that did catch it, made the problem look
 * cosmetic.
 *
 * What is retried is decided by the method, with two endpoints overriding it on
 * behaviour measured against the live API rather than assumed.
 */
describe('a transient gateway failure is retried rather than surfaced', () => {
	it('recovers a control-plane read that blips once', async () => {
		const { calls } = scriptFetch([
			{ status: 502, raw: GATEWAY_502 },
			{ body: { id: 'sbx-1', state: 'started' } },
		]);
		const got = await client().getSandbox('sbx-1');
		expect(got?.id).toBe('sbx-1');
		expect(calls).toHaveLength(2);
	});

	it('gives up after a bounded number of attempts, on one readable line', async () => {
		// Bounded, because a provider that is genuinely down should surface as an
		// error promptly rather than as a request that takes a minute to fail. The
		// message is collapsed to a line: this one lands once per project per sync
		// tick while an outage lasts, and the raw HTML page made it six.
		const { calls } = scriptFetch([{ status: 502, raw: GATEWAY_502 }]);
		const err = await client()
			.getSandbox('sbx-1')
			.catch((e) => e);
		expect(err).toBeInstanceOf(DaytonaApiError);
		expect(err.status).toBe(502);
		expect(calls).toHaveLength(4);
		expect(err.message).not.toContain('\n');
		expect(err.message).toContain('502 Bad Gateway');
	});

	it('never re-sends a sandbox create', async () => {
		// A create that turns out to have landed would be a second billable
		// sandbox, so this one stays out by the method default.
		const { calls } = scriptFetch([{ status: 502, raw: GATEWAY_502 }]);
		await expect(client().createSandbox({ dockerfileContent: 'FROM x\n' })).rejects.toBeInstanceOf(
			DaytonaApiError,
		);
		expect(calls).toHaveLength(1);
	});

	it('re-sends an idempotent delete and reads the follow-up 404 as done', async () => {
		// The other half of what makes a delete safe to retry: measured, a repeat
		// answers "not there", which is the desired end state rather than a failure.
		const { calls } = scriptFetch([
			{ status: 502, raw: GATEWAY_502 },
			{ status: 404, body: { message: 'not found' } },
		]);
		await expect(client().deleteFile(sandbox, '/workspace/gone')).resolves.toBeUndefined();
		expect(calls).toHaveLength(2);
	});

	it('retries a session create and reads the conflict as already-created', async () => {
		// The one POST that is retried, and it is safe for a reason specific to the
		// endpoint rather than to the method: the session id is minted on this side,
		// so a re-send carries the same id. Measured against the live API, that
		// answers 409 CONFLICT and leaves the session fully usable - the exec, its
		// log stream and its command record all work against it afterwards. Worth
		// having because this is the first call of the exec every agent run, git
		// operation and chat turn goes through.
		let creates = 0;
		vi.stubGlobal('fetch', async (input: string | URL | Request) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (url.endsWith('/process/session')) {
				creates += 1;
				if (creates === 1) return new Response(GATEWAY_502, { status: 502 });
				return new Response(
					JSON.stringify({ statusCode: 409, code: 'CONFLICT', message: 'session already exists' }),
					{ status: 409 },
				);
			}
			if (url.endsWith('/exec')) return Response.json({ cmdId: 'cmd-1' });
			if (url.includes('/logs')) return new Response('one\ntwo\n');
			if (url.includes('/command/cmd-1')) return Response.json({ exitCode: 3 });
			return Response.json({});
		});

		const lines: string[] = [];
		const { exitCode } = await client().executeStreaming(sandbox, 'echo hi', (l) => {
			lines.push(l);
		});
		expect(creates).toBe(2);
		expect(exitCode).toBe(3);
		expect(lines).toEqual(['one\n', 'two\n']);
	});

	it('never re-sends the exec that starts the command', async () => {
		// Unlike the session create above: a re-send of a request that landed runs
		// the command twice.
		let execs = 0;
		vi.stubGlobal('fetch', async (input: string | URL | Request) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (url.endsWith('/exec')) {
				execs += 1;
				return new Response(GATEWAY_502, { status: 502 });
			}
			return Response.json({});
		});
		await expect(client().executeStreaming(sandbox, 'echo hi', () => {})).rejects.toThrow();
		expect(execs).toBe(1);
	});
});

/**
 * The failure the retry cannot cover, because it is not an exception: a gateway
 * error page is a perfectly good response body, and the log reader consumed it
 * as if the command had written it.
 */
describe('a gateway error page is never mistaken for command output', () => {
	function scriptLogStream(logReply: (attempt: number) => Response) {
		let attempts = 0;
		vi.stubGlobal('fetch', async (input: string | URL | Request) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (url.endsWith('/exec')) return Response.json({ cmdId: 'cmd-1' });
			if (url.includes('/logs')) {
				attempts += 1;
				return logReply(attempts);
			}
			if (url.includes('/command/cmd-1')) return Response.json({ exitCode: 0 });
			return Response.json({});
		});
		return () => attempts;
	}

	it('keeps the 502 page out of the agent log and reopens the stream', async () => {
		// Left unchecked this decoded the page and handed it to `onLine` as the
		// command's own output - `<html><head><title>502 Bad Gateway</title>` in an
		// agent's run log - and then reported a clean exit, because the stream ends
		// and the exit code comes from a separate call.
		const attempts = scriptLogStream((n) =>
			n === 1 ? new Response(GATEWAY_502, { status: 502 }) : new Response('one\ntwo\n'),
		);

		const lines: string[] = [];
		const { exitCode } = await client().executeStreaming(sandbox, 'echo hi', (l) => {
			lines.push(l);
		});

		expect(attempts()).toBe(2);
		expect(exitCode).toBe(0);
		expect(lines).toEqual(['one\n', 'two\n']);
		expect(lines.join('')).not.toContain('502');
	});

	it('gives up on a stream the gateway will not open, naming the transport', async () => {
		// The same bound the mid-stream drop already had, reused rather than
		// duplicated: every reopen replays the whole log from byte 0.
		const attempts = scriptLogStream(() => new Response(GATEWAY_502, { status: 502 }));
		await expect(client().executeStreaming(sandbox, 'echo hi', () => {})).rejects.toThrow(
			/output stream .* closed before the command finished/,
		);
		expect(attempts()).toBe(6);
	});

	it('surfaces a refused log stream that will not come back on its own', async () => {
		// A 4xx is the service answering, not the edge failing - reconnecting is
		// pointless and would just spend the bound.
		const attempts = scriptLogStream(() => new Response('nope', { status: 403 }));
		const err = await client()
			.executeStreaming(sandbox, 'echo hi', () => {})
			.catch((e) => e);
		expect(err).toBeInstanceOf(DaytonaApiError);
		expect(err.status).toBe(403);
		expect(attempts()).toBe(1);
	});

	it('names the provider when the command record cannot be read', async () => {
		// `json()` on an HTML page throws a bare SyntaxError naming neither the
		// provider nor the status - and any shape that did parse would take the
		// `?? 0` and report a failed command as a clean exit.
		vi.stubGlobal('fetch', async (input: string | URL | Request) => {
			const url = typeof input === 'string' ? input : input.toString();
			if (url.endsWith('/exec')) return Response.json({ cmdId: 'cmd-1' });
			if (url.includes('/logs')) return new Response('one\n');
			if (url.includes('/command/cmd-1')) return new Response(GATEWAY_502, { status: 502 });
			return Response.json({});
		});
		const err = await client()
			.executeStreaming(sandbox, 'echo hi', () => {})
			.catch((e) => e);
		expect(err).toBeInstanceOf(DaytonaApiError);
		expect(err.status).toBe(502);
		expect(err.message).toContain('command record fetch failed');
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

describe('openPty refuses a session the provider did not create', () => {
	it('throws a named error instead of connecting a socket to nothing', async () => {
		// The gap this closes. `send` hands the response back rather than
		// interpreting it, and this was the one call site that discarded it - so a
		// refused create fell through to a WebSocket for a session that does not
		// exist. That socket closes on its own a moment later, which the tunnel
		// reports as "the exec channel carrying the tunnel closed" and the run as
		// "the tunnel client did not bind its ports within 30000ms": a 30-second
		// wait naming neither the provider nor the status, reading as a broken
		// container rather than as one refused request.
		let socketsOpened = 0;
		vi.stubGlobal(
			'fetch',
			async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
		);
		vi.stubGlobal(
			'WebSocket',
			class {
				constructor() {
					socketsOpened++;
				}
			},
		);

		await expect(
			new DaytonaClient('k', BASE).openPty(sandbox, 'sess-fail', 'hezo-tunnel /c'),
		).rejects.toThrow(DaytonaApiError);
		// And it fails *before* the socket, so nothing is left half-open.
		expect(socketsOpened).toBe(0);
	});

	it('names the provider and the status, and collapses the gateway HTML', async () => {
		vi.stubGlobal(
			'fetch',
			async () =>
				new Response('<html>\n  <title>502 Bad Gateway</title>\n</html>', { status: 502 }),
		);
		vi.stubGlobal('WebSocket', class {});
		const err = await new DaytonaClient('k', BASE)
			.openPty(sandbox, 'sess-fail-2', 'hezo-tunnel /c')
			.catch((e: unknown) => e as DaytonaApiError);
		expect(err).toBeInstanceOf(DaytonaApiError);
		expect((err as DaytonaApiError).message).toContain('POST /process/pty failed (502)');
		// One line, not the page's layout - this lands in a run log.
		expect((err as DaytonaApiError).message).not.toContain('\n');
	});
});

// A caller signal used to *replace* the per-attempt timeout rather than joining
// it, so every call made with one was unbounded. Those are exactly the calls a
// run makes while it holds a container and the provider credential, so one
// wedged request parked the run - and every later run on that credential -
// with nothing able to time it out.
describe('a caller signal never costs a call its timeout', () => {
	/**
	 * A request that answers nothing and ends only when its signal says so.
	 * Teardown DELETEs are answered rather than hung, so a spec measures the call
	 * it is about rather than the session cleanup behind it.
	 */
	function hangingFetch(): { signals: Array<AbortSignal | undefined> } {
		const signals: Array<AbortSignal | undefined> = [];
		vi.stubGlobal('fetch', (_input: string | URL | Request, init?: RequestInit) => {
			if ((init?.method ?? 'GET') === 'DELETE') return Promise.resolve(Response.json({}));
			signals.push(init?.signal ?? undefined);
			return new Promise<Response>((_resolve, reject) => {
				// Same contract as the real thing, which rejects an already-aborted
				// request rather than waiting for an event that has been and gone.
				if (init?.signal?.aborted) return reject(init.signal.reason);
				init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
			});
		});
		return { signals };
	}

	it('still times out an execute() given a signal that never fires', async () => {
		hangingFetch();
		const ac = new AbortController();
		const err = await client()
			.execute(sandbox, 'sleep 1000', { signal: ac.signal, timeoutMs: 25 })
			.catch((e: unknown) => e as Error);
		expect((err as Error).name).toBe('TimeoutError');
	});

	it('still lets the caller cancel well before the timeout', async () => {
		hangingFetch();
		const ac = new AbortController();
		const pending = client()
			.execute(sandbox, 'sleep 1000', { signal: ac.signal, timeoutMs: 60_000 })
			.catch((e: unknown) => e as Error);
		ac.abort(new Error('caller cancelled'));
		expect(((await pending) as Error).message).toBe('caller cancelled');
	});

	it('still bounds a call the caller gave no signal for', async () => {
		const { signals } = hangingFetch();
		const err = await client()
			.execute(sandbox, 'sleep 1000', { timeoutMs: 25 })
			.catch((e: unknown) => e as Error);
		expect((err as Error).name).toBe('TimeoutError');
		expect(signals[0]).toBeDefined();
	});
});

// The production failure this exists for: a stopped or still-starting sandbox
// answers 400 - not a transient status - so nothing generic caught it and every
// run lost to a sandbox the provider had stopped underneath it was burned as a
// permanent failure, with no retry and a failure ping on the task.
describe('a sandbox that is not up reads as unreachable, not as a bad request', () => {
	const NOT_STARTED = JSON.stringify({
		statusCode: 400,
		message:
			'bad request: failed to resolve container IP after 3 attempts: no IP address found. Is the Sandbox started?',
		code: 'BAD_REQUEST',
	});

	it('raises a backend-agnostic error from a file write', async () => {
		scriptFetch([{ status: 400, raw: NOT_STARTED }]);
		const err = await client()
			.createFolder(sandbox, '/workspace')
			.catch((e: unknown) => e as Error);
		expect((err as Error).name).toBe('ContainerUnreachableError');
	});

	it('raises it from an exec too', async () => {
		scriptFetch([{ status: 400, raw: NOT_STARTED }]);
		const err = await client()
			.execute(sandbox, 'echo hi')
			.catch((e: unknown) => e as Error);
		expect((err as Error).name).toBe('ContainerUnreachableError');
	});

	it('leaves an ordinary bad request as a provider error', async () => {
		scriptFetch([{ status: 400, body: { message: 'invalid command' } }]);
		const err = await client()
			.execute(sandbox, 'echo hi')
			.catch((e: unknown) => e as Error);
		expect(err).toBeInstanceOf(DaytonaApiError);
	});

	it('names no backend, so nothing above the seam learns which provider it was', async () => {
		scriptFetch([{ status: 400, raw: NOT_STARTED }]);
		const err = await client()
			.execute(sandbox, 'echo hi')
			.catch((e: unknown) => e as Error);
		expect((err as Error).name).not.toMatch(/Daytona/);
	});
});

import { describe, expect, it, vi } from 'vitest';
import {
	handleEnvelope,
	SlackSocketClient,
	type WebSocketLike,
} from '../src/services/chat-channels/slack-socket';

const envelope = (obj: unknown) => JSON.stringify(obj);

describe('handleEnvelope (pure protocol decisions)', () => {
	it('hello resets to connected', () => {
		expect(handleEnvelope(envelope({ type: 'hello', num_connections: 1 }))).toEqual({
			hello: true,
		});
	});

	it('disconnect asks for a reconnect', () => {
		expect(handleEnvelope(envelope({ type: 'disconnect', reason: 'refresh_requested' }))).toEqual({
			reconnect: true,
		});
	});

	it('events_api yields ack + inner event + event id', () => {
		const d = handleEnvelope(
			envelope({
				envelope_id: 'env-1',
				type: 'events_api',
				payload: { event_id: 'Ev1', event: { type: 'app_mention', text: 'hi' } },
			}),
		);
		expect(d.ack).toBe('env-1');
		expect(d.eventId).toBe('Ev1');
		expect(d.event).toEqual({ type: 'app_mention', text: 'hi' });
	});

	it('other enveloped types are acked and dropped', () => {
		const d = handleEnvelope(
			envelope({ envelope_id: 'env-2', type: 'slash_commands', payload: { command: '/x' } }),
		);
		expect(d).toEqual({ ack: 'env-2' });
	});

	it('ignores malformed frames', () => {
		expect(handleEnvelope('not json')).toEqual({});
		expect(handleEnvelope(envelope('just a string'))).toEqual({});
		expect(handleEnvelope(42)).toEqual({});
	});
});

/** Scriptable fake WebSocket capturing sends and letting tests emit frames. */
class FakeWs implements WebSocketLike {
	sent: string[] = [];
	closed = false;
	private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
	constructor(readonly url: string) {}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.closed = true;
		this.emit('close');
	}
	addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
		const arr = this.listeners.get(type) ?? [];
		arr.push(listener);
		this.listeners.set(type, arr);
	}
	emit(type: string, data?: unknown): void {
		for (const l of this.listeners.get(type) ?? []) l({ data });
	}
}

function makeClient(opts?: { openError?: string }) {
	const sockets: FakeWs[] = [];
	const events: unknown[] = [];
	let ticket = 0;
	const fetchFn = vi.fn(async () => {
		ticket++;
		const body = opts?.openError
			? { ok: false, error: opts.openError }
			: { ok: true, url: `wss://sock/${ticket}` };
		return new Response(JSON.stringify(body), { status: 200 });
	});
	const client = new SlackSocketClient({
		getAppToken: async () => 'xapp-test',
		onEvent: (e) => events.push(e),
		webSocketFactory: (url) => {
			const ws = new FakeWs(url);
			sockets.push(ws);
			return ws;
		},
		fetchFn: fetchFn as unknown as typeof fetch,
	});
	return { client, sockets, events, fetchFn };
}

describe('SlackSocketClient lifecycle', () => {
	it('connects, acks before dispatch, dedupes redelivered events', async () => {
		const { client, sockets, events } = makeClient();
		client.start();
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		const ws = sockets[0];
		ws.emit('message', envelope({ type: 'hello' }));

		const frame = envelope({
			envelope_id: 'env-1',
			type: 'events_api',
			payload: { event_id: 'Ev1', event: { type: 'app_mention', text: 'hi' } },
		});
		ws.emit('message', frame);
		expect(ws.sent).toEqual([envelope({ envelope_id: 'env-1' })]);
		expect(events).toEqual([{ type: 'app_mention', text: 'hi' }]);

		// Slack redelivery of the same event id: acked again, dispatched once.
		ws.emit('message', frame);
		expect(ws.sent).toHaveLength(2);
		expect(events).toHaveLength(1);
		client.stop();
	});

	it('reconnects with a fresh ticket on a disconnect envelope', async () => {
		const { client, sockets, fetchFn } = makeClient();
		client.start();
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		sockets[0].emit('message', envelope({ type: 'hello' }));

		sockets[0].emit('message', envelope({ type: 'disconnect', reason: 'refresh_requested' }));
		await vi.waitFor(() => expect(sockets).toHaveLength(2));
		// Tickets are single-use: connections.open was called once per connect.
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(sockets[1].url).toBe('wss://sock/2');
		client.stop();
	});

	it('stops permanently when the app token is rejected', async () => {
		const { client, sockets } = makeClient({ openError: 'invalid_auth' });
		client.start();
		await vi.waitFor(() => expect(client.isRunning()).toBe(false));
		expect(sockets).toHaveLength(0);
	});

	it('stop() closes the socket and prevents reconnection', async () => {
		const { client, sockets, fetchFn } = makeClient();
		client.start();
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		client.stop();
		expect(sockets[0].closed).toBe(true);
		// The close event fired by stop() must not schedule a new connect.
		await new Promise((r) => setTimeout(r, 20));
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(sockets).toHaveLength(1);
	});

	it('start() is idempotent while running', async () => {
		const { client, sockets } = makeClient();
		client.start();
		client.start();
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		await new Promise((r) => setTimeout(r, 20));
		expect(sockets).toHaveLength(1);
		client.stop();
	});
});

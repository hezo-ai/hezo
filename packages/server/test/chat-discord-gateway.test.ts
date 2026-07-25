import { describe, expect, it, vi } from 'vitest';
import {
	DISCORD_INTENTS,
	DiscordGatewayClient,
	handleGatewayFrame,
} from '../src/services/chat-channels/discord-gateway';
import type { WebSocketLike } from '../src/services/chat-channels/slack-socket';

const frame = (obj: unknown) => JSON.stringify(obj);

describe('handleGatewayFrame (pure protocol decisions)', () => {
	it('HELLO carries the heartbeat interval', () => {
		expect(handleGatewayFrame(frame({ op: 10, d: { heartbeat_interval: 41250 } }))).toEqual({
			helloIntervalMs: 41250,
		});
	});

	it('dispatch frames carry the event and record the sequence', () => {
		const d = handleGatewayFrame(frame({ op: 0, t: 'MESSAGE_CREATE', s: 7, d: { content: 'hi' } }));
		expect(d.seq).toBe(7);
		expect(d.dispatch).toEqual({ name: 'MESSAGE_CREATE', data: { content: 'hi' } });
	});

	it('maps reconnect, invalid-session, and heartbeat opcodes', () => {
		expect(handleGatewayFrame(frame({ op: 7 }))).toEqual({ reconnect: true });
		expect(handleGatewayFrame(frame({ op: 9, d: true }))).toEqual({
			invalidSession: { resumable: true },
		});
		expect(handleGatewayFrame(frame({ op: 9, d: false }))).toEqual({
			invalidSession: { resumable: false },
		});
		expect(handleGatewayFrame(frame({ op: 1 }))).toEqual({ heartbeatNow: true });
		expect(handleGatewayFrame(frame({ op: 11 }))).toEqual({ heartbeatAck: true });
	});

	it('ignores malformed frames', () => {
		expect(handleGatewayFrame('not json')).toEqual({});
		expect(handleGatewayFrame(42)).toEqual({});
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

function makeClient() {
	const sockets: FakeWs[] = [];
	const dispatched: Array<{ name: string; data: unknown }> = [];
	const client = new DiscordGatewayClient({
		getToken: async () => 'bot-token',
		onDispatch: (name, data) => dispatched.push({ name, data }),
		webSocketFactory: (url) => {
			const ws = new FakeWs(url);
			sockets.push(ws);
			return ws;
		},
		gatewayUrl: 'wss://fake-gateway',
	});
	return { client, sockets, dispatched };
}

describe('DiscordGatewayClient lifecycle', () => {
	it('identifies with the bot token + intents after HELLO and dispatches events', async () => {
		const { client, sockets, dispatched } = makeClient();
		client.start();
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		const ws = sockets[0];
		ws.emit('message', frame({ op: 10, d: { heartbeat_interval: 60_000 } }));
		await vi.waitFor(() => expect(ws.sent).toHaveLength(1));

		const identify = JSON.parse(ws.sent[0]) as {
			op: number;
			d: { token: string; intents: number };
		};
		expect(identify.op).toBe(2);
		expect(identify.d.token).toBe('bot-token');
		expect(identify.d.intents).toBe(DISCORD_INTENTS);

		ws.emit(
			'message',
			frame({ op: 0, t: 'READY', s: 1, d: { session_id: 's1', resume_gateway_url: 'wss://r' } }),
		);
		ws.emit('message', frame({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { content: 'hi' } }));
		expect(dispatched.map((d) => d.name)).toEqual(['READY', 'MESSAGE_CREATE']);
		client.stop();
	});

	it('RESUMEs with the session + sequence after a server-requested reconnect', async () => {
		const { client, sockets } = makeClient();
		client.start();
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		const first = sockets[0];
		first.emit('message', frame({ op: 10, d: { heartbeat_interval: 60_000 } }));
		await vi.waitFor(() => expect(first.sent).toHaveLength(1));
		first.emit(
			'message',
			frame({
				op: 0,
				t: 'READY',
				s: 1,
				d: { session_id: 's1', resume_gateway_url: 'wss://resume' },
			}),
		);
		first.emit('message', frame({ op: 0, t: 'MESSAGE_CREATE', s: 5, d: {} }));

		first.emit('message', frame({ op: 7 }));
		await vi.waitFor(() => expect(sockets).toHaveLength(2));
		const second = sockets[1];
		expect(second.url.startsWith('wss://resume')).toBe(true);
		second.emit('message', frame({ op: 10, d: { heartbeat_interval: 60_000 } }));
		await vi.waitFor(() => expect(second.sent).toHaveLength(1));
		const resume = JSON.parse(second.sent[0]) as {
			op: number;
			d: { session_id: string; seq: number };
		};
		expect(resume.op).toBe(6);
		expect(resume.d.session_id).toBe('s1');
		expect(resume.d.seq).toBe(5);
		client.stop();
	});

	it('re-identifies fresh after a non-resumable invalid session', async () => {
		const { client, sockets } = makeClient();
		client.start();
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		const first = sockets[0];
		first.emit('message', frame({ op: 10, d: { heartbeat_interval: 60_000 } }));
		await vi.waitFor(() => expect(first.sent).toHaveLength(1));
		first.emit('message', frame({ op: 0, t: 'READY', s: 1, d: { session_id: 's1' } }));

		first.emit('message', frame({ op: 9, d: false }));
		await vi.waitFor(() => expect(sockets).toHaveLength(2));
		const second = sockets[1];
		second.emit('message', frame({ op: 10, d: { heartbeat_interval: 60_000 } }));
		await vi.waitFor(() => expect(second.sent).toHaveLength(1));
		expect((JSON.parse(second.sent[0]) as { op: number }).op).toBe(2);
		client.stop();
	});

	it('answers a server heartbeat request with the tracked sequence', async () => {
		const { client, sockets } = makeClient();
		client.start();
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		const ws = sockets[0];
		ws.emit('message', frame({ op: 10, d: { heartbeat_interval: 60_000 } }));
		await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
		ws.emit('message', frame({ op: 0, t: 'READY', s: 3, d: {} }));
		ws.emit('message', frame({ op: 1 }));
		const beat = JSON.parse(ws.sent.at(-1) ?? '{}') as { op: number; d: number };
		expect(beat).toEqual({ op: 1, d: 3 });
		client.stop();
	});

	it('stop() closes the socket and prevents reconnection', async () => {
		const { client, sockets } = makeClient();
		client.start();
		await vi.waitFor(() => expect(sockets).toHaveLength(1));
		client.stop();
		expect(sockets[0].closed).toBe(true);
		await new Promise((r) => setTimeout(r, 20));
		expect(sockets).toHaveLength(1);
		expect(client.isRunning()).toBe(false);
	});
});

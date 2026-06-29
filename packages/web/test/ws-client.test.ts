// Pure-logic unit tests for the WebSocketClient wrapper around
// reconnecting-websocket. We never open a real socket: the component-tier setup
// stubs the global WebSocket, and where a connection-state-gated branch needs an
// OPEN socket we inject a controllable fake into the client's private `ws` field
// (the unit under test is WebSocketClient's own bookkeeping, not RWS).
import {
	WsClientAction,
	WsMessageType,
	type WsRowChangeMessage,
	type WsServerMessage,
} from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocketClient } from '../src/lib/ws';

/** A minimal hand-rolled socket exposing the surface WebSocketClient reads/writes. */
interface FakeSocket {
	readyState: number;
	sent: string[];
	closed: number;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onmessage: ((event: { data: string }) => void) | null;
	send: (data: string) => void;
	close: () => void;
}

function makeFakeSocket(readyState: number): FakeSocket {
	const fake: FakeSocket = {
		readyState,
		sent: [],
		closed: 0,
		onopen: null,
		onclose: null,
		onmessage: null,
		send(data: string) {
			this.sent.push(data);
		},
		close() {
			this.closed++;
		},
	};
	return fake;
}

/** Swap in a controllable fake for the client's private RWS instance. */
function injectSocket(client: WebSocketClient, socket: FakeSocket): void {
	(client as unknown as { ws: FakeSocket }).ws = socket;
}

const OPEN = WebSocket.OPEN;
const CLOSED = WebSocket.CLOSED;

describe('WebSocketClient', () => {
	const originalLocation = window.location;

	beforeEach(() => {
		// Default to an https origin so URL building defaults to wss:.
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: { protocol: 'https:', host: 'app.example.com' } as Location,
		});
	});

	afterEach(() => {
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: originalLocation,
		});
		vi.restoreAllMocks();
	});

	describe('connect() URL building', () => {
		// reconnecting-websocket builds the underlying socket lazily, so its `.url`
		// getter is timing-dependent. Capture the URL deterministically by spying
		// on the global WebSocket constructor that RWS instantiates.
		// RWS instantiates the underlying socket on a 0ms setTimeout, so await a
		// macrotask while the spy is installed before reading the captured URL.
		async function captureUrl(token: string | null): Promise<string> {
			const urls: string[] = [];
			const Real = globalThis.WebSocket;
			class Capturing extends (Real as unknown as { new (...a: unknown[]): object }) {
				constructor(...args: unknown[]) {
					super(...args);
					urls.push(String(args[0]));
				}
			}
			(globalThis as unknown as { WebSocket: unknown }).WebSocket = Capturing;
			const client = new WebSocketClient();
			try {
				client.connect(token);
				await new Promise((r) => setTimeout(r, 5));
			} finally {
				client.disconnect();
				(globalThis as unknown as { WebSocket: unknown }).WebSocket = Real;
			}
			expect(urls.length).toBeGreaterThan(0);
			return urls[0];
		}

		test('builds a wss:// URL with an encoded token on an https origin', async () => {
			expect(await captureUrl('a b/c+d')).toBe('wss://app.example.com/ws?token=a%20b%2Fc%2Bd');
		});

		test('builds a ws:// URL on a plain http origin', async () => {
			Object.defineProperty(window, 'location', {
				configurable: true,
				value: { protocol: 'http:', host: 'localhost:3000' } as Location,
			});
			expect(await captureUrl('tok')).toBe('ws://localhost:3000/ws?token=tok');
		});

		test('omits the query string entirely when token is null', async () => {
			expect(await captureUrl(null)).toBe('wss://app.example.com/ws');
		});
	});

	describe('onopen', () => {
		test('reports connected and replays every subscribed room as Subscribe sends', () => {
			const client = new WebSocketClient();
			const statuses: boolean[] = [];
			client.onStatusChange = (c) => statuses.push(c);

			// Queue subscriptions while disconnected (no socket yet) — they buffer.
			client.subscribe('team:1');
			client.subscribe('task:2');

			client.connect('tok');
			// Make the real wrapper's handlers fire against a fake OPEN socket.
			const fake = makeFakeSocket(OPEN);
			fake.onopen = (client as unknown as { ws: { onopen: () => void } }).ws.onopen;
			injectSocket(client, fake);

			fake.onopen?.();

			expect(statuses).toEqual([true]);
			const replays = fake.sent.map((s) => JSON.parse(s));
			expect(replays).toEqual([
				{ action: WsClientAction.Subscribe, room: 'team:1' },
				{ action: WsClientAction.Subscribe, room: 'task:2' },
			]);
		});
	});

	describe('onclose', () => {
		test('reports disconnected', () => {
			const client = new WebSocketClient();
			const statuses: boolean[] = [];
			client.onStatusChange = (c) => statuses.push(c);
			client.connect('tok');
			(client as unknown as { ws: { onclose: () => void } }).ws.onclose();
			expect(statuses).toEqual([false]);
		});
	});

	describe('onmessage dispatch', () => {
		function emit(client: WebSocketClient, data: string): void {
			(client as unknown as { ws: { onmessage: (e: { data: string }) => void } }).ws.onmessage({
				data,
			});
		}

		test('routes a parsed message to handlers registered for its type', () => {
			const client = new WebSocketClient();
			client.connect('tok');
			const seen: WsServerMessage[] = [];
			client.on(WsMessageType.RowChange, (m) => seen.push(m));

			const msg: WsRowChangeMessage = {
				type: WsMessageType.RowChange,
				table: 'tasks',
				action: 'UPDATE',
				row: { id: 'x' },
			};
			emit(client, JSON.stringify(msg));
			expect(seen).toEqual([msg]);
		});

		test('invokes every handler registered for the same type', () => {
			const client = new WebSocketClient();
			client.connect('tok');
			const a = vi.fn();
			const b = vi.fn();
			client.on(WsMessageType.Connected, a);
			client.on(WsMessageType.Connected, b);
			emit(client, JSON.stringify({ type: WsMessageType.Connected }));
			expect(a).toHaveBeenCalledTimes(1);
			expect(b).toHaveBeenCalledTimes(1);
		});

		test('drops a message whose type has no registered handler', () => {
			const client = new WebSocketClient();
			client.connect('tok');
			const handler = vi.fn();
			client.on(WsMessageType.RowChange, handler);
			emit(client, JSON.stringify({ type: WsMessageType.ProjectsChanged }));
			expect(handler).not.toHaveBeenCalled();
		});

		test('silently ignores a malformed (non-JSON) frame', () => {
			const client = new WebSocketClient();
			client.connect('tok');
			const handler = vi.fn();
			client.on(WsMessageType.RowChange, handler);
			expect(() => emit(client, 'not json {')).not.toThrow();
			expect(handler).not.toHaveBeenCalled();
		});
	});

	describe('on() registration bookkeeping', () => {
		test('returns an unsubscribe that removes only that handler', () => {
			const client = new WebSocketClient();
			client.connect('tok');
			const a = vi.fn();
			const b = vi.fn();
			const offA = client.on(WsMessageType.RowChange, a);
			client.on(WsMessageType.RowChange, b);

			offA();

			(client as unknown as { ws: { onmessage: (e: { data: string }) => void } }).ws.onmessage({
				data: JSON.stringify({
					type: WsMessageType.RowChange,
					table: 't',
					action: 'INSERT',
					row: {},
				}),
			});
			expect(a).not.toHaveBeenCalled();
			expect(b).toHaveBeenCalledTimes(1);
		});

		test('unsubscribing the last handler prunes the type entry', () => {
			const client = new WebSocketClient();
			const handler = vi.fn();
			const off = client.on(WsMessageType.RowChange, handler);
			const handlers = (client as unknown as { handlers: Map<WsMessageType, Set<unknown>> })
				.handlers;
			expect(handlers.has(WsMessageType.RowChange)).toBe(true);
			off();
			expect(handlers.has(WsMessageType.RowChange)).toBe(false);
		});

		test('calling the same unsubscribe twice is harmless', () => {
			const client = new WebSocketClient();
			const off = client.on(WsMessageType.Connected, vi.fn());
			off();
			expect(() => off()).not.toThrow();
		});
	});

	describe('subscribe / unsubscribe', () => {
		test('subscribe buffers the room and sends immediately when the socket is OPEN', () => {
			const client = new WebSocketClient();
			const fake = makeFakeSocket(OPEN);
			injectSocket(client, fake);

			client.subscribe('team:abc');

			const rooms = (client as unknown as { subscribedRooms: Set<string> }).subscribedRooms;
			expect(rooms.has('team:abc')).toBe(true);
			expect(JSON.parse(fake.sent[0])).toEqual({
				action: WsClientAction.Subscribe,
				room: 'team:abc',
			});
		});

		test('subscribe buffers but does not send while the socket is not OPEN', () => {
			const client = new WebSocketClient();
			const fake = makeFakeSocket(CLOSED);
			injectSocket(client, fake);

			client.subscribe('team:abc');

			const rooms = (client as unknown as { subscribedRooms: Set<string> }).subscribedRooms;
			expect(rooms.has('team:abc')).toBe(true);
			expect(fake.sent).toEqual([]);
		});

		test('unsubscribe removes the room and sends Unsubscribe when OPEN', () => {
			const client = new WebSocketClient();
			const fake = makeFakeSocket(OPEN);
			injectSocket(client, fake);
			client.subscribe('team:abc');
			fake.sent.length = 0;

			client.unsubscribe('team:abc');

			const rooms = (client as unknown as { subscribedRooms: Set<string> }).subscribedRooms;
			expect(rooms.has('team:abc')).toBe(false);
			expect(JSON.parse(fake.sent[0])).toEqual({
				action: WsClientAction.Unsubscribe,
				room: 'team:abc',
			});
		});

		test('unsubscribe removes the room but sends nothing while not OPEN', () => {
			const client = new WebSocketClient();
			const fake = makeFakeSocket(CLOSED);
			injectSocket(client, fake);
			(client as unknown as { subscribedRooms: Set<string> }).subscribedRooms.add('team:abc');

			client.unsubscribe('team:abc');

			const rooms = (client as unknown as { subscribedRooms: Set<string> }).subscribedRooms;
			expect(rooms.has('team:abc')).toBe(false);
			expect(fake.sent).toEqual([]);
		});

		test('subscribe with no socket at all only buffers (no throw)', () => {
			const client = new WebSocketClient();
			expect(() => client.subscribe('team:abc')).not.toThrow();
			const rooms = (client as unknown as { subscribedRooms: Set<string> }).subscribedRooms;
			expect(rooms.has('team:abc')).toBe(true);
		});
	});

	describe('connected getter', () => {
		test('false before any connect', () => {
			const client = new WebSocketClient();
			expect(client.connected).toBe(false);
		});

		test('true when the underlying socket reports OPEN', () => {
			const client = new WebSocketClient();
			injectSocket(client, makeFakeSocket(OPEN));
			expect(client.connected).toBe(true);
		});

		test('false when the underlying socket is not OPEN', () => {
			const client = new WebSocketClient();
			injectSocket(client, makeFakeSocket(CLOSED));
			expect(client.connected).toBe(false);
		});
	});

	describe('disconnect', () => {
		test('closes the socket, nulls it out, and clears buffered rooms', () => {
			const client = new WebSocketClient();
			const fake = makeFakeSocket(OPEN);
			injectSocket(client, fake);
			client.subscribe('team:abc');
			client.subscribe('team:def');

			client.disconnect();

			expect(fake.closed).toBe(1);
			expect((client as unknown as { ws: unknown }).ws).toBeNull();
			expect((client as unknown as { subscribedRooms: Set<string> }).subscribedRooms.size).toBe(0);
			expect(client.connected).toBe(false);
		});

		test('disconnect with no socket is a no-op', () => {
			const client = new WebSocketClient();
			expect(() => client.disconnect()).not.toThrow();
			expect((client as unknown as { ws: unknown }).ws).toBeNull();
		});
	});
});

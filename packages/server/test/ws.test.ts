import { describe, expect, it } from 'vitest';
import { broadcastEvent } from '../src/lib/broadcast';
import { WebSocketManager, type WsSocket } from '../src/services/ws';

function createMockWs(): WsSocket & { _sent: string[] } {
	const sent: string[] = [];
	return {
		data: {
			auth: { type: 'admin', userId: 'test-user' },
			rooms: new Set<string>(),
		},
		send(msg: string) {
			sent.push(msg);
		},
		_sent: sent,
	};
}

describe('WebSocketManager', () => {
	it('subscribes and broadcasts to a room', () => {
		const mgr = new WebSocketManager();
		const ws = createMockWs();

		mgr.subscribe(ws, 'team:abc');
		expect(mgr.getRoomSize('team:abc')).toBe(1);

		mgr.broadcast('team:abc', { type: 'test', value: 42 });
		expect(ws._sent).toHaveLength(1);
		expect(JSON.parse(ws._sent[0])).toEqual({ type: 'test', value: 42 });
	});

	it('unsubscribes from a room', () => {
		const mgr = new WebSocketManager();
		const ws = createMockWs();

		mgr.subscribe(ws, 'team:abc');
		mgr.unsubscribe(ws, 'team:abc');
		expect(mgr.getRoomSize('team:abc')).toBe(0);

		mgr.broadcast('team:abc', { type: 'test' });
		expect(ws._sent).toHaveLength(0);
	});

	it('unsubscribes from all rooms', () => {
		const mgr = new WebSocketManager();
		const ws = createMockWs();

		mgr.subscribe(ws, 'team:abc');
		mgr.subscribe(ws, 'task:xyz');
		expect(ws.data.rooms.size).toBe(2);

		mgr.unsubscribeAll(ws);
		expect(mgr.getRoomSize('team:abc')).toBe(0);
		expect(mgr.getRoomSize('task:xyz')).toBe(0);
		expect(ws.data.rooms.size).toBe(0);
	});

	it('broadcasts to multiple subscribers', () => {
		const mgr = new WebSocketManager();
		const ws1 = createMockWs();
		const ws2 = createMockWs();

		mgr.subscribe(ws1, 'team:abc');
		mgr.subscribe(ws2, 'team:abc');

		mgr.broadcast('team:abc', { type: 'update' });
		expect(ws1._sent).toHaveLength(1);
		expect(ws2._sent).toHaveLength(1);
	});

	it('does not broadcast to other rooms', () => {
		const mgr = new WebSocketManager();
		const ws1 = createMockWs();
		const ws2 = createMockWs();

		mgr.subscribe(ws1, 'team:abc');
		mgr.subscribe(ws2, 'team:def');

		mgr.broadcast('team:abc', { type: 'update' });
		expect(ws1._sent).toHaveLength(1);
		expect(ws2._sent).toHaveLength(0);
	});

	it('cleans up empty rooms', () => {
		const mgr = new WebSocketManager();
		const ws = createMockWs();

		mgr.subscribe(ws, 'team:abc');
		mgr.unsubscribe(ws, 'team:abc');
		expect(mgr.getRoomSize('team:abc')).toBe(0);
	});

	it('tracks total connections across rooms', () => {
		const mgr = new WebSocketManager();
		const ws1 = createMockWs();
		const ws2 = createMockWs();

		mgr.subscribe(ws1, 'team:abc');
		mgr.subscribe(ws1, 'task:xyz');
		mgr.subscribe(ws2, 'team:abc');

		expect(mgr.getTotalConnections()).toBe(2);
	});

	it('handles broadcast to non-existent room gracefully', () => {
		const mgr = new WebSocketManager();
		mgr.broadcast('nonexistent', { type: 'test' });
	});
});

describe('broadcastEvent helper', () => {
	it('sends event with type and data merged', () => {
		const mgr = new WebSocketManager();
		const ws = createMockWs();
		mgr.subscribe(ws, 'team:abc');

		broadcastEvent(mgr, 'team:abc', 'agent_lifecycle', { memberId: '123', status: 'idle' });

		expect(ws._sent).toHaveLength(1);
		const parsed = JSON.parse(ws._sent[0]);
		expect(parsed.type).toBe('agent_lifecycle');
		expect(parsed.memberId).toBe('123');
		expect(parsed.status).toBe('idle');
	});
});

describe('WebSocketManager - backpressure shedding', () => {
	function createStuckWs(result: number): WsSocket & { _closed: boolean; _attempts: number } {
		const socket = {
			data: {
				auth: { type: 'admin', userId: 'test-user' },
				rooms: new Set<string>(),
			},
			_closed: false,
			_attempts: 0,
			send(_msg: string): number {
				socket._attempts += 1;
				return result;
			},
			close() {
				socket._closed = true;
			},
		};
		return socket;
	}

	it('sheds a socket after sustained backpressure and closes it', () => {
		const mgr = new WebSocketManager();
		const stuck = createStuckWs(-1);
		const healthy = createMockWs();
		mgr.subscribe(stuck, 'team:abc');
		mgr.subscribe(healthy, 'team:abc');

		for (let i = 0; i < 100; i++) mgr.broadcast('team:abc', { type: 'tick', i });

		// The stuck socket is out of every room and closed; the healthy one
		// received every frame untouched.
		expect(mgr.getRoomSize('team:abc')).toBe(1);
		expect(stuck._closed).toBe(true);
		expect(stuck.data.rooms.size).toBe(0);
		expect(healthy._sent).toHaveLength(100);
	});

	it('a dropped-frame socket (send returns 0) is shed the same way', () => {
		const mgr = new WebSocketManager();
		const broken = createStuckWs(0);
		mgr.subscribe(broken, 'team:abc');
		for (let i = 0; i < 100; i++) mgr.broadcast('team:abc', { type: 'tick', i });
		expect(mgr.getRoomSize('team:abc')).toBe(0);
		expect(broken._closed).toBe(true);
	});

	it('a recovering socket clears its strikes and stays subscribed', () => {
		const mgr = new WebSocketManager();
		let result = -1;
		const socket = {
			data: {
				auth: { type: 'admin', userId: 'test-user' },
				rooms: new Set<string>(),
			},
			send(_msg: string): number {
				return result;
			},
			close() {
				throw new Error('must not close a recovering socket');
			},
		};
		mgr.subscribe(socket, 'team:abc');
		for (let i = 0; i < 99; i++) mgr.broadcast('team:abc', { type: 'tick', i });
		// One delivered frame resets the strike count entirely.
		result = 10;
		mgr.broadcast('team:abc', { type: 'tick' });
		result = -1;
		for (let i = 0; i < 99; i++) mgr.broadcast('team:abc', { type: 'tick', i });
		expect(mgr.getRoomSize('team:abc')).toBe(1);
	});

	it('a void-returning send (test doubles) is treated as delivered', () => {
		const mgr = new WebSocketManager();
		const ws = createMockWs();
		mgr.subscribe(ws, 'team:abc');
		for (let i = 0; i < 200; i++) mgr.broadcast('team:abc', { type: 'tick', i });
		expect(mgr.getRoomSize('team:abc')).toBe(1);
		expect(ws._sent).toHaveLength(200);
	});
});

import { describe, expect, it } from 'vitest';
import { broadcastEvent } from '../../lib/broadcast';
import { WebSocketManager, type WsSocket } from '../../services/ws';

function createMockWs(): WsSocket & { _sent: string[] } {
	const sent: string[] = [];
	return {
		data: {
			auth: { type: 'board', userId: 'test-user' },
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

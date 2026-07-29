import { describe, expect, it } from 'vitest';
import {
	ACTIVE_WAKEUP_STATUSES,
	TERMINAL_WAKEUP_STATUSES,
	WakeupStatus,
} from '../src/types/common';
import {
	CONNECTOR_CAPABILITIES,
	getConnectorCapability,
} from '../src/types/connector-capabilities';
import { WsClientAction, WsMessageType } from '../src/types/websocket';

describe('websocket message enums', () => {
	it('exposes stable wire values', () => {
		expect(WsMessageType.RowChange).toBe('row_change');
		expect(WsMessageType.ChatMessageDelta).toBe('chat_message_delta');
		expect(WsClientAction.Subscribe).toBe('subscribe');
		expect(WsClientAction.Unsubscribe).toBe('unsubscribe');
	});
});

describe('connector capabilities', () => {
	it('looks up a known connector and its device-auth config', () => {
		const gh = getConnectorCapability('github');
		expect(gh?.displayName).toBe('GitHub');
		expect(gh?.allowedHosts).toContain('github.com');
		expect(gh?.scopes).toContain('repo');
		expect(gh?.deviceAuth?.clientIdEnv).toBe('GITHUB_OAUTH_CLIENT_ID');
	});

	it('returns undefined for an unknown connector', () => {
		expect(getConnectorCapability('does-not-exist')).toBeUndefined();
	});

	it('keeps every registry entry id in sync with its key', () => {
		for (const [key, cap] of Object.entries(CONNECTOR_CAPABILITIES)) {
			expect(cap.id).toBe(key);
			expect(cap.mcpServer.transport).toBeTruthy();
		}
	});
});

describe('wakeup status partitioning', () => {
	// The maintenance sweep deletes rows whose status is in
	// TERMINAL_WAKEUP_STATUSES, so a status that belongs in neither list would be
	// invisible to the scheduler's "still active" checks *and* to the sweep, and
	// one that lands in both would be deleted while still pending. Adding a
	// status must therefore be a deliberate choice, not a default.
	it('splits every WakeupStatus into exactly one of active or terminal', () => {
		const all = Object.values(WakeupStatus).sort();
		const partitioned = [...ACTIVE_WAKEUP_STATUSES, ...TERMINAL_WAKEUP_STATUSES].sort();
		expect(partitioned).toEqual(all);
		for (const status of ACTIVE_WAKEUP_STATUSES) {
			expect(TERMINAL_WAKEUP_STATUSES).not.toContain(status);
		}
	});

	it('treats deferred as active, since a cleared blocker re-queues it', () => {
		expect(ACTIVE_WAKEUP_STATUSES).toContain(WakeupStatus.Deferred);
		expect(TERMINAL_WAKEUP_STATUSES).not.toContain(WakeupStatus.Deferred);
	});
});

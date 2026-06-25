import { describe, expect, it } from 'vitest';
import {
	CONNECTOR_CAPABILITIES,
	getConnectorCapability,
} from '../src/types/connector-capabilities';
import { WsClientAction, WsMessageType } from '../src/types/websocket';

describe('websocket message enums', () => {
	it('exposes stable wire values', () => {
		expect(WsMessageType.RowChange).toBe('row_change');
		expect(WsMessageType.CeoMessageDelta).toBe('ceo_message_delta');
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

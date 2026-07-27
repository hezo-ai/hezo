import { describe, expect, it } from 'vitest';
import {
	mcpMethodBlockedMessage,
	shouldBlockMcpRequest,
} from '../src/services/egress/mcp-method-guard';

/**
 * The proxy leg of method access. These are the rules that hold regardless of
 * which runtime made the call — including Codex and Grok, which expose no
 * config-level tool filter and so are restricted by nothing else.
 */

const ENABLED = new Set(['get_issue', 'list_issues']);

function rpc(method: string, params?: Record<string, unknown>): string {
	return JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });
}

describe('shouldBlockMcpRequest', () => {
	it('allows a call to an enabled method', () => {
		const v = shouldBlockMcpRequest(rpc('tools/call', { name: 'get_issue' }), ENABLED);
		expect(v.blocked).toBe(false);
	});

	it('blocks a call to a method that is not on the allowlist', () => {
		const v = shouldBlockMcpRequest(rpc('tools/call', { name: 'delete_issue' }), ENABLED);
		expect(v).toEqual({ blocked: true, method: 'delete_issue', reason: 'not_enabled' });
	});

	it('blocks a method the server added after the allowlist was written', () => {
		// The allowlist names what is enabled, not what is disabled — so a method
		// nobody has ever seen is withheld rather than allowed by omission.
		const v = shouldBlockMcpRequest(rpc('tools/call', { name: 'brand_new_tool' }), ENABLED);
		expect(v.blocked).toBe(true);
	});

	it('leaves the rest of the protocol alone', () => {
		for (const method of ['initialize', 'tools/list', 'ping', 'notifications/initialized']) {
			expect(shouldBlockMcpRequest(rpc(method), ENABLED).blocked).toBe(false);
		}
	});

	it('allows a tools/list even though it will advertise disabled tools', () => {
		// Hiding tools is the config leg's job. Listing them is harmless here
		// precisely because calling them is blocked.
		expect(shouldBlockMcpRequest(rpc('tools/list'), ENABLED).blocked).toBe(false);
	});

	it('allows a response message, which carries no method at all', () => {
		const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
		expect(shouldBlockMcpRequest(body, ENABLED).blocked).toBe(false);
	});

	describe('batches', () => {
		it('allows a batch whose calls are all enabled', () => {
			const body = JSON.stringify([
				{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_issue' } },
				{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_issues' } },
			]);
			expect(shouldBlockMcpRequest(body, ENABLED).blocked).toBe(false);
		});

		it('rejects the whole batch when any one call is disabled', () => {
			// The messages share a body — there is no way to forward the rest
			// without also forwarding the disabled one.
			const body = JSON.stringify([
				{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_issue' } },
				{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_issue' } },
			]);
			const v = shouldBlockMcpRequest(body, ENABLED);
			expect(v).toEqual({ blocked: true, method: 'delete_issue', reason: 'not_enabled' });
		});

		it('allows an empty batch', () => {
			expect(shouldBlockMcpRequest('[]', ENABLED).blocked).toBe(false);
		});
	});

	describe('fails closed', () => {
		it('blocks a body that is not JSON', () => {
			const v = shouldBlockMcpRequest('not json at all', ENABLED);
			expect(v).toEqual({ blocked: true, method: null, reason: 'unparseable' });
		});

		it('blocks an empty body', () => {
			expect(shouldBlockMcpRequest('', ENABLED).blocked).toBe(true);
		});

		it('blocks a tools/call with no params', () => {
			expect(shouldBlockMcpRequest(rpc('tools/call'), ENABLED).blocked).toBe(true);
		});

		it('blocks a tools/call whose tool name is not a string', () => {
			const v = shouldBlockMcpRequest(rpc('tools/call', { name: { $ne: null } }), ENABLED);
			expect(v).toEqual({ blocked: true, method: null, reason: 'unparseable' });
		});

		it('blocks a batch element that is not an object', () => {
			const body = JSON.stringify([{ jsonrpc: '2.0', method: 'tools/list' }, 'nonsense']);
			expect(shouldBlockMcpRequest(body, ENABLED).blocked).toBe(true);
		});

		it('blocks a bare JSON scalar', () => {
			expect(shouldBlockMcpRequest('42', ENABLED).blocked).toBe(true);
		});
	});

	it('blocks everything when the allowlist is empty, which is not the same as absent', () => {
		// An empty allowlist is a deliberate "nothing is enabled". The proxy only
		// ever sees restricted hosts, so an unrestricted connector never reaches
		// here at all.
		const v = shouldBlockMcpRequest(rpc('tools/call', { name: 'get_issue' }), new Set());
		expect(v.blocked).toBe(true);
	});
});

describe('mcpMethodBlockedMessage', () => {
	it('names the method and the connector so the agent can act on it', () => {
		const msg = mcpMethodBlockedMessage(
			{ blocked: true, method: 'delete_issue', reason: 'not_enabled' },
			'linear',
		);
		expect(msg).toContain('delete_issue');
		expect(msg).toContain('linear');
		// A bare 403 reads as a broken credential and invites a retry loop; this
		// has to say the tool is disabled, not missing.
		expect(msg).toMatch(/not enabled/i);
	});

	it('explains an uninspectable body rather than implying a bad credential', () => {
		const msg = mcpMethodBlockedMessage(
			{ blocked: true, method: null, reason: 'unparseable' },
			'linear',
		);
		expect(msg).toContain('linear');
		expect(msg).toMatch(/could not be inspected/i);
	});
});

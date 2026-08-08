import { describe, expect, it } from 'vitest';
import {
	CONNECTOR_OAUTH_STATUS_NONE,
	ConnectorStatus,
	connectorNeedsHuman,
	connectorOAuthStatus,
	connectorStatus,
	isConnectorUsable,
} from '../src/mcp/connector-status';

const base = {
	kind: 'saas',
	oauth_connection_id: null,
	api_key_secret_id: null,
	activated_at: null,
	revoked_at: null,
	auth_error: null,
};

describe('connectorStatus', () => {
	it('reports a connector whose token stopped refreshing as degraded, not active', () => {
		// The defect this type exists for: an OAuth connector that WAS working and
		// whose grant later expired. `activated_at` stays stamped and
		// `oauth_connection_id` stays attached, so the old ladder fell through to
		// `active` and the operator saw a green "Connected" chip over a red error.
		expect(
			connectorStatus({
				...base,
				oauth_connection_id: 'oc-1',
				activated_at: '2026-08-01T00:00:00Z',
				auth_error: 'token refresh: token endpoint error: invalid_grant',
			}),
		).toBe(ConnectorStatus.Degraded);
	});

	it('still reports a never-activated failure as failed', () => {
		expect(connectorStatus({ ...base, auth_error: 'discovery failed' })).toBe(
			ConnectorStatus.Failed,
		);
	});

	it('lets an explicit disconnect win over a recorded auth error', () => {
		expect(
			connectorStatus({
				...base,
				oauth_connection_id: 'oc-1',
				activated_at: '2026-08-01T00:00:00Z',
				auth_error: 'token refresh: invalid_grant',
				revoked_at: '2026-08-02T00:00:00Z',
			}),
		).toBe(ConnectorStatus.Revoked);
	});

	it('keeps the healthy paths unchanged', () => {
		expect(connectorStatus({ ...base, oauth_connection_id: 'oc-1', activated_at: 'now' })).toBe(
			ConnectorStatus.Active,
		);
		expect(connectorStatus({ ...base, api_key_secret_id: 'sec-1', activated_at: 'now' })).toBe(
			ConnectorStatus.Active,
		);
		expect(connectorStatus({ ...base, kind: 'local' })).toBe(ConnectorStatus.Active);
		expect(connectorStatus(base)).toBe(ConnectorStatus.Pending);
	});

	it('can report a local connector broken - the auth branches sit above the local short-circuit', () => {
		expect(connectorStatus({ ...base, kind: 'local', auth_error: 'login failed' })).toBe(
			ConnectorStatus.Failed,
		);
		expect(
			connectorStatus({ ...base, kind: 'local', activated_at: 'now', auth_error: 'expired' }),
		).toBe(ConnectorStatus.Degraded);
	});

	it('classifies degraded as needing a human and not usable', () => {
		expect(isConnectorUsable(ConnectorStatus.Degraded)).toBe(false);
		expect(connectorNeedsHuman(ConnectorStatus.Degraded)).toBe(true);
		expect(isConnectorUsable(ConnectorStatus.Active)).toBe(true);
		expect(connectorNeedsHuman(ConnectorStatus.Active)).toBe(false);
	});
});

describe('connectorOAuthStatus', () => {
	const oauthBase = { ...base, config: null, created_by_task_id: null };

	it('reports no OAuth story for non-SaaS rows', () => {
		// Preserves the MCP tool's existing contract: local/api rows have never
		// reported a connector state here, and collapsing the ladders must not
		// start making them report `active`.
		expect(connectorOAuthStatus({ ...oauthBase, kind: 'local' })).toBe(CONNECTOR_OAUTH_STATUS_NONE);
		expect(
			connectorOAuthStatus({
				...oauthBase,
				kind: 'api',
				api_key_secret_id: 'k',
				activated_at: 'now',
			}),
		).toBe(CONNECTOR_OAUTH_STATUS_NONE);
	});

	it('separates a real pending connect from a row nobody has started', () => {
		expect(connectorOAuthStatus(oauthBase)).toBe(CONNECTOR_OAUTH_STATUS_NONE);
		expect(connectorOAuthStatus({ ...oauthBase, config: { dcr: {} } })).toBe(
			ConnectorStatus.Pending,
		);
		expect(connectorOAuthStatus({ ...oauthBase, created_by_task_id: 'task-1' })).toBe(
			ConnectorStatus.Pending,
		);
	});

	it('surfaces degraded to agents', () => {
		expect(
			connectorOAuthStatus({
				...oauthBase,
				oauth_connection_id: 'oc-1',
				activated_at: 'now',
				auth_error: 'token refresh: invalid_grant',
			}),
		).toBe(ConnectorStatus.Degraded);
	});
});

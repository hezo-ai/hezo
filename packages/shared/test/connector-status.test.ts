import { describe, expect, it } from 'vitest';
import {
	CONNECTOR_OAUTH_STATUS_NONE,
	ConnectorStatus,
	connectorIsCredentialed,
	connectorNeedsHuman,
	connectorOAuthStatus,
	connectorStatus,
	isConnectorUsable,
} from '../src/mcp/connector-status';

const base = {
	kind: 'saas',
	config: null,
	oauth_connection_id: null,
	api_key_secret_id: null,
	activated_at: null,
	revoked_at: null,
	auth_error: null,
	probed_at: null,
	probe_error: null,
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

describe('connectorStatus on an uncredentialed hosted server', () => {
	it('reads pending until a probe has actually answered', () => {
		// The bug: a row like this was assumed public, handed to every run, and
		// 401ed at handshake inside the container where nothing could see it.
		expect(connectorStatus(base)).toBe(ConnectorStatus.Pending);
	});

	it('reads active once a probe completed the handshake', () => {
		expect(connectorStatus({ ...base, probed_at: '2026-08-01T00:00:00Z' })).toBe(
			ConnectorStatus.Active,
		);
	});

	it('reads pending again when the last probe failed', () => {
		expect(
			connectorStatus({
				...base,
				probed_at: '2026-08-01T00:00:00Z',
				probe_error: 'auth_required',
			}),
		).toBe(ConnectorStatus.Pending);
		expect(
			connectorStatus({
				...base,
				probed_at: '2026-08-01T00:00:00Z',
				probe_error: 'unreachable',
			}),
		).toBe(ConnectorStatus.Pending);
	});

	it('takes a placeholder header as a credential, with no probe needed', () => {
		// The egress proxy substitutes it at request time. Nothing on this side can
		// reproduce that, so a probe of such a row could only ever record a refusal
		// that says nothing about whether the connector works in a run.
		const withHeader = {
			...base,
			config: { headers: { Authorization: 'Bearer __HEZO_SECRET_TYPEFULLY_KEY__' } },
		};
		expect(connectorStatus(withHeader)).toBe(ConnectorStatus.Active);
		// And a failed probe of it does not take that away.
		expect(connectorStatus({ ...withHeader, probed_at: 'now', probe_error: 'auth_required' })).toBe(
			ConnectorStatus.Active,
		);
	});

	it('ignores a header value that is not a valid placeholder', () => {
		expect(
			connectorStatus({ ...base, config: { headers: { 'X-Key': '__HEZO_SECRET_lower__' } } }),
		).toBe(ConnectorStatus.Pending);
		expect(connectorStatus({ ...base, config: { headers: { 'X-Key': 'plain-value' } } })).toBe(
			ConnectorStatus.Pending,
		);
	});

	it('never lets probe evidence outrank a recorded failure', () => {
		expect(
			connectorStatus({ ...base, probed_at: 'now', auth_error: 'connect attempt errored' }),
		).toBe(ConnectorStatus.Failed);
		expect(connectorStatus({ ...base, probed_at: 'now', revoked_at: 'now' })).toBe(
			ConnectorStatus.Revoked,
		);
	});
});

describe('connectorOAuthStatus', () => {
	it('reports no OAuth story for non-SaaS rows', () => {
		// Preserves the MCP tool's existing contract: local/api rows have never
		// reported a connector state here, and collapsing the ladders must not
		// start making them report `active`.
		expect(connectorOAuthStatus({ ...base, kind: 'local' })).toBe(CONNECTOR_OAUTH_STATUS_NONE);
		expect(
			connectorOAuthStatus({
				...base,
				kind: 'api',
				api_key_secret_id: 'k',
				activated_at: 'now',
			}),
		).toBe(CONNECTOR_OAUTH_STATUS_NONE);
	});

	it('reads an unproven hosted row as pending rather than none', () => {
		// `none` used to double as "nobody has started connecting this", which read
		// to an agent as "no auth needed" for exactly the rows that needed some.
		expect(connectorOAuthStatus(base)).toBe(ConnectorStatus.Pending);
		expect(connectorOAuthStatus({ ...base, config: { dcr: {} } })).toBe(ConnectorStatus.Pending);
	});

	it('reads a proven hosted row as active', () => {
		expect(connectorOAuthStatus({ ...base, probed_at: 'now' })).toBe(ConnectorStatus.Active);
		expect(
			connectorOAuthStatus({
				...base,
				config: { headers: { 'X-Api-Key': '__HEZO_SECRET_TYPEFULLY__' } },
			}),
		).toBe(ConnectorStatus.Active);
	});

	it('surfaces degraded to agents', () => {
		expect(
			connectorOAuthStatus({
				...base,
				oauth_connection_id: 'oc-1',
				activated_at: 'now',
				auth_error: 'token refresh: invalid_grant',
			}),
		).toBe(ConnectorStatus.Degraded);
	});
});

describe('connectorIsCredentialed', () => {
	// The three arms have to stay in step with SAAS_CREDENTIALED_SQL, which is
	// what actually decides whether a hosted connector reaches an agent run.
	it('counts each credential a run would send', () => {
		expect(connectorIsCredentialed({ ...base, oauth_connection_id: 'oc-1' })).toBe(true);
		expect(connectorIsCredentialed({ ...base, api_key_secret_id: 'sec-1' })).toBe(true);
		expect(
			connectorIsCredentialed({
				...base,
				config: { headers: { 'X-Api-Key': '__HEZO_SECRET_TYPEFULLY__' } },
			}),
		).toBe(true);
	});

	it('counts a bare hosted row as uncredentialed, however it was last probed', () => {
		expect(connectorIsCredentialed(base)).toBe(false);
		expect(
			connectorIsCredentialed({ ...base, config: { headers: { 'X-Api-Key': 'literal' } } }),
		).toBe(false);
		// Probe evidence is not a credential: it is the *substitute* for one, which
		// is why a failed probe keeps only this group out of runs.
		expect(connectorIsCredentialed({ ...base, probed_at: 'now', probe_error: null })).toBe(false);
	});
});

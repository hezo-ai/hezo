import { McpConnectionKind } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import {
	createOrFetchConnector,
	getConnector,
	listConnectors,
	markActive,
	markFailed,
	markRevoked,
	statusOf,
} from '../src/services/connectors/lifecycle';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

/**
 * Branch-coverage companion for `services/connectors/lifecycle.ts`. The
 * existing `connectors.test.ts` covers the create→active→revoke happy path and
 * idempotency-on-name; this file drives the remaining arms:
 *  - statusOf: revoked / failed / active / pending precedence
 *  - createOrFetchConnector: revoked-row restoration, the local-command config
 *    branch, and the SaaS-with-headers/env config branch
 *  - markActive / markFailed / markRevoked / getConnector: the `null` return on
 *    an unknown connector id
 */

let db: Db;
const UNKNOWN = '00000000-0000-0000-0000-000000000000';

let ocSeq = 0;
async function seedOauthConnection(): Promise<string> {
	const secret = await db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value) VALUES ($1, 'enc') RETURNING id`,
		[`OC_TOKEN_${ocSeq++}`],
	);
	const oc = await db.query<{ id: string }>(
		`INSERT INTO oauth_connections
		 (provider, provider_account_id, provider_account_label, access_token_secret_id)
		 VALUES ('mcp:test', $1, 'Test', $2) RETURNING id`,
		[`acct-${ocSeq}`, secret.rows[0].id],
	);
	return oc.rows[0].id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
});

afterAll(async () => {
	await safeClose(db);
});

describe('statusOf precedence', () => {
	const base = {
		kind: McpConnectionKind.Saas,
		oauth_connection_id: null,
		activated_at: null,
		revoked_at: null,
		auth_error: null,
	};

	it('revoked wins over everything', () => {
		expect(
			statusOf({
				...base,
				revoked_at: 'now',
				activated_at: 'now',
				oauth_connection_id: 'oc',
				auth_error: 'e',
			}),
		).toBe('revoked');
	});

	it('failed when there is an auth_error and it never activated', () => {
		expect(statusOf({ ...base, auth_error: 'boom' })).toBe('failed');
	});

	it('active when oauth + activated_at are both present (auth_error after activation does not flip to failed)', () => {
		expect(
			statusOf({ ...base, oauth_connection_id: 'oc', activated_at: 'now', auth_error: 'stale' }),
		).toBe('active');
	});

	it('pending when nothing is set', () => {
		expect(statusOf(base)).toBe('pending');
	});

	it('pending when activated but missing the oauth connection id', () => {
		expect(statusOf({ ...base, activated_at: 'now' })).toBe('pending');
	});

	it('active for a local connector with no oauth (credential-placeholder auth)', () => {
		// Local (stdio) connectors log in via __HEZO_SECRET_*__ placeholders, not
		// OAuth, so they are connected as soon as the row exists.
		expect(statusOf({ ...base, kind: McpConnectionKind.Local })).toBe('active');
	});

	it('revoked still wins over a local connector', () => {
		expect(statusOf({ ...base, kind: McpConnectionKind.Local, revoked_at: 'now' })).toBe('revoked');
	});

	it('failed still wins over a local connector', () => {
		expect(statusOf({ ...base, kind: McpConnectionKind.Local, auth_error: 'boom' })).toBe('failed');
	});
});

describe('createOrFetchConnector — config + restore branches', () => {
	it('builds a local-command config when no mcpUrl is supplied', async () => {
		const { row, alreadyExisted } = await createOrFetchConnector(db, {
			name: 'local-cmd-connector',
			displayName: 'Local Cmd',
			mcpCmd: 'my-mcp-server',
			mcpArgs: ['--flag'],
			mcpEnv: { TOKEN: 'x' },
			mcpTransport: 'stdio',
		});
		expect(alreadyExisted).toBe(false);
		expect(row.kind).toBe(McpConnectionKind.Local);
		expect(row.config).toEqual({ command: 'my-mcp-server', args: ['--flag'], env: { TOKEN: 'x' } });
	});

	it('defaults local args/env when omitted', async () => {
		const { row } = await createOrFetchConnector(db, {
			name: 'local-defaults-connector',
			displayName: 'Local Defaults',
			mcpCmd: 'bare-server',
			mcpTransport: 'stdio',
		});
		expect(row.config).toEqual({ command: 'bare-server', args: [], env: {} });
	});

	it('builds a SaaS config with headers + env when an mcpUrl is supplied', async () => {
		const { row } = await createOrFetchConnector(db, {
			name: 'saas-headers-connector',
			displayName: 'SaaS Headers',
			mcpUrl: 'https://api.example/mcp',
			mcpHeaders: { Authorization: 'Bearer placeholder' },
			mcpEnv: { REGION: 'eu' },
			mcpTransport: 'http',
		});
		expect(row.kind).toBe(McpConnectionKind.Saas);
		expect(row.config).toEqual({
			url: 'https://api.example/mcp',
			headers: { Authorization: 'Bearer placeholder' },
			env: { REGION: 'eu' },
		});
	});

	it('restores a previously-revoked row for re-authorization (alreadyExisted, cleared fields)', async () => {
		const { row: created } = await createOrFetchConnector(db, {
			name: 'restore-connector',
			displayName: 'Restore Me',
			mcpUrl: 'https://api.example/mcp',
			mcpTransport: 'http',
		});
		const ocId = await seedOauthConnection();
		await markActive(db, created.id, ocId);
		await markRevoked(db, created.id);
		const revoked = await getConnector(db, created.id);
		expect(statusOf(revoked!)).toBe('revoked');

		const { row: restored, alreadyExisted } = await createOrFetchConnector(db, {
			name: 'restore-connector',
			displayName: 'Restore Me',
			mcpUrl: 'https://api.example/mcp',
			mcpTransport: 'http',
		});
		expect(alreadyExisted).toBe(true);
		expect(restored.revoked_at).toBeNull();
		expect(restored.auth_error).toBeNull();
		expect(restored.oauth_connection_id).toBeNull();
		expect(restored.activated_at).toBeNull();
		expect(statusOf(restored)).toBe('pending');

		// And the persisted row reflects the restore, not just the returned copy.
		const persisted = await getConnector(db, created.id);
		expect(statusOf(persisted!)).toBe('pending');
	});

	it('returns an existing non-revoked row unchanged (alreadyExisted, no restore)', async () => {
		await createOrFetchConnector(db, {
			name: 'unchanged-connector',
			displayName: 'Unchanged',
			mcpUrl: 'https://api.example/mcp',
			mcpTransport: 'http',
		});
		const { row, alreadyExisted } = await createOrFetchConnector(db, {
			name: 'unchanged-connector',
			displayName: 'Different Display Ignored',
			mcpUrl: 'https://api.example/other',
			mcpTransport: 'http',
		});
		expect(alreadyExisted).toBe(true);
		// Original config preserved — the second call does not overwrite.
		expect((row.config as { url: string }).url).toBe('https://api.example/mcp');
	});
});

describe('null returns on unknown connector id', () => {
	it('markActive returns null', async () => {
		const ocId = await seedOauthConnection();
		expect(await markActive(db, UNKNOWN, ocId)).toBeNull();
	});
	it('markFailed returns null', async () => {
		expect(await markFailed(db, UNKNOWN, 'nope')).toBeNull();
	});
	it('markRevoked returns null', async () => {
		expect(await markRevoked(db, UNKNOWN)).toBeNull();
	});
	it('getConnector returns null', async () => {
		expect(await getConnector(db, UNKNOWN)).toBeNull();
	});
	it('listConnectors returns the rows created in this suite', async () => {
		const rows = await listConnectors(db);
		expect(rows.some((r) => r.name === 'local-cmd-connector')).toBe(true);
	});
});

import { AgentRuntime, ConnectorProbeError } from '@hezo/shared';
import { Logger } from '@hiddentao/logger';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/database';
import { loadConnectorsForRun } from '../src/services/connectors/connections';
import {
	describeConnectorRejection,
	isRuntimeDroppedCredential,
	recheckRejectedConnector,
} from '../src/services/connectors/run-rejection';
import type { ConnectorRunRejection } from '../src/services/egress/proxy';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';
import { startTestMcpHttpServer } from './helpers/test-mcp-http-server';

/**
 * What a run's connector refusal is turned into: the immediate sentence, and
 * the re-check that writes the connector's health through its sanctioned writer
 * and says what it found. The proxy-side observation is covered in
 * `egress-connector-rejection.test.ts`; this file starts from the event.
 */

let ctx: Awaited<ReturnType<typeof createTestApp>>;
let db: Db;
let projectId: string;
let teamId: string;

const TOOLS = [{ name: 'get_issue', description: 'Fetch an issue' }];

function event(overrides: Partial<ConnectorRunRejection> = {}): ConnectorRunRejection {
	return {
		connectorId: '00000000-0000-0000-0000-000000000000',
		connectorName: 'ibkr',
		credentialed: true,
		kind: 'upstream_rejected',
		status: 401,
		reason: 'http_401',
		credentialSent: true,
		...overrides,
	};
}

async function encryptForTest(value: string): Promise<string> {
	const key = ctx.masterKeyManager.getKey();
	if (!key) throw new Error('test master key unavailable');
	const { encrypt } = await import('../src/crypto/encryption');
	return encrypt(value, key);
}

async function seedConnector(url: string, credential: 'oauth' | 'api_key' | null): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO mcp_connections (name, kind, config, install_status, project_id, activated_at)
		 VALUES ($1, 'saas', $2::jsonb, 'installed', $3, now()) RETURNING id`,
		[`ibkr-${Math.random().toString(36).slice(2, 8)}`, JSON.stringify({ url }), projectId],
	);
	const id = r.rows[0].id;
	if (credential === 'api_key') {
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
			 VALUES ($1, $2, 'api_token'::secret_category, '{127.0.0.1}') RETURNING id`,
			[
				`MCP_KEY_${Math.random().toString(36).slice(2, 8)}`.toUpperCase(),
				await encryptForTest('live-key'),
			],
		);
		await db.query(`UPDATE mcp_connections SET api_key_secret_id = $1 WHERE id = $2`, [
			secret.rows[0].id,
			id,
		]);
	} else if (credential === 'oauth') {
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value) VALUES ($1, $2) RETURNING id`,
			[`TOK_${Math.random().toString(36).slice(2, 8)}`, await encryptForTest('stale-token')],
		);
		const conn = await db.query<{ id: string }>(
			`INSERT INTO oauth_connections
			   (provider, provider_account_id, provider_account_label, access_token_secret_id)
			 VALUES ('fake', $1, 'Fake', $2) RETURNING id`,
			[`acct-${Math.random().toString(36).slice(2, 8)}`, secret.rows[0].id],
		);
		await db.query(`UPDATE mcp_connections SET oauth_connection_id = $1 WHERE id = $2`, [
			conn.rows[0].id,
			id,
		]);
	}
	return id;
}

function recordingWs() {
	const broadcasts: Array<{ room: string; event: Record<string, unknown> }> = [];
	const wsManager = {
		broadcast: (room: string, ev: Record<string, unknown>) => broadcasts.push({ room, event: ev }),
	} as unknown as NonNullable<Parameters<typeof recheckRejectedConnector>[0]['wsManager']>;
	return { broadcasts, wsManager };
}

function captureErrors(): () => string[] {
	const seen: string[] = [];
	vi.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => {
		seen.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
	});
	return () => seen;
}

beforeAll(async () => {
	ctx = await createTestApp();
	db = ctx.db;
	const team = await db.query<{ id: string }>(
		`INSERT INTO teams (name, slug) VALUES ('Refusal Co', 'refusal-co') RETURNING id`,
	);
	teamId = team.rows[0].id;
	const project = await db.query<{ id: string }>(
		`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'Work', 'work', 'WO') RETURNING id`,
		[teamId],
	);
	projectId = project.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('describeConnectorRejection', () => {
	it('names the runtime that dropped a configured credential', () => {
		const line = describeConnectorRejection(event({ credentialSent: false }), AgentRuntime.Codex);
		expect(line).toContain('connector "ibkr" refused this run\'s request (HTTP 401)');
		expect(line).toContain('carried no credential although one is configured');
		expect(line).toContain('Codex runtime is not sending it');
		expect(isRuntimeDroppedCredential(event({ credentialSent: false }))).toBe(true);
	});

	it('says the credential was sent when it was', () => {
		const line = describeConnectorRejection(event(), AgentRuntime.ClaudeCode);
		expect(line).toContain('although its credential was sent');
		expect(isRuntimeDroppedCredential(event())).toBe(false);
	});

	it('says an uncredentialed connector now requires one', () => {
		const line = describeConnectorRejection(
			event({ credentialed: false, credentialSent: false }),
			AgentRuntime.ClaudeCode,
		);
		expect(line).toContain('it now requires a credential');
		expect(isRuntimeDroppedCredential(event({ credentialed: false, credentialSent: false }))).toBe(
			false,
		);
	});

	it('echoes a substitution failure and an unreachable errno', () => {
		expect(
			describeConnectorRejection(
				event({
					kind: 'substitution_failed',
					status: 0,
					reason: 'secret_not_allowed_for_host',
					detail: 'Secret X is not permitted for host y.',
				}),
				AgentRuntime.ClaudeCode,
			),
		).toContain(
			'could not substitute the credential for connector "ibkr" (secret_not_allowed_for_host): Secret X',
		);
		expect(
			describeConnectorRejection(
				event({ kind: 'upstream_unreachable', status: 0, reason: 'ECONNREFUSED' }),
				AgentRuntime.ClaudeCode,
			),
		).toContain('was unreachable from this run (ECONNREFUSED)');
	});
});

describe('recheckRejectedConnector', () => {
	it('confirms a refused credential, records it on the connector, and broadcasts', async () => {
		const unauthorized = await startTestMcpHttpServer({ failWithStatus: 401 });
		try {
			const id = await seedConnector(`http://127.0.0.1:${unauthorized.port}/mcp`, 'oauth');
			const { broadcasts, wsManager } = recordingWs();
			const line = await recheckRejectedConnector(
				{ db, masterKeyManager: ctx.masterKeyManager, wsManager },
				event({ connectorId: id }),
				{ label: 'test', teamId, projectId },
			);
			expect(line).toContain('no longer accepted');
			expect(line).toContain('reconnect');
			const row = await db.query<{ auth_error: string | null }>(
				`SELECT auth_error FROM mcp_connections WHERE id = $1`,
				[id],
			);
			expect(row.rows[0].auth_error).toContain('401');
			expect(broadcasts).toHaveLength(1);
			expect(broadcasts[0].event).toMatchObject({
				table: 'mcp_connections',
				row: { id, team_id: teamId, project_id: projectId },
			});
		} finally {
			await unauthorized.close();
		}
	});

	it('calls out a runtime that dropped a working credential as a Hezo defect', async () => {
		const healthy = await startTestMcpHttpServer({ tools: TOOLS });
		try {
			const id = await seedConnector(`http://127.0.0.1:${healthy.port}/mcp`, 'api_key');
			const errors = captureErrors();
			const line = await recheckRejectedConnector(
				{ db, masterKeyManager: ctx.masterKeyManager },
				event({ connectorId: id, credentialSent: false }),
				{ label: 'test', teamId, projectId },
			);
			expect(line).toContain('the credential is fine and the runtime is not sending it');
			expect(line).toContain('Hezo defect');
			expect(errors().some((e) => e.includes('without its credential'))).toBe(true);
			const row = await db.query<{ auth_error: string | null }>(
				`SELECT auth_error FROM mcp_connections WHERE id = $1`,
				[id],
			);
			expect(row.rows[0].auth_error).toBeNull();
		} finally {
			await healthy.close();
		}
	});

	it('withholds an uncredentialed connector that now demands auth from later runs', async () => {
		const unauthorized = await startTestMcpHttpServer({ failWithStatus: 401 });
		try {
			const id = await seedConnector(`http://127.0.0.1:${unauthorized.port}/mcp`, null);
			// Proven public once, so a run was given it.
			await db.query(`UPDATE mcp_connections SET probed_at = now() WHERE id = $1`, [id]);
			expect((await loadConnectorsForRun(db, projectId)).some((r) => r.id === id)).toBe(true);

			const line = await recheckRejectedConnector(
				{ db, masterKeyManager: ctx.masterKeyManager },
				event({ connectorId: id, credentialed: false, credentialSent: false }),
				{ label: 'test', teamId, projectId },
			);
			expect(line).toContain('now requires a credential');
			expect(line).toContain('held back from later runs');
			const row = await db.query<{ auth_error: string | null; probe_error: string | null }>(
				`SELECT auth_error, probe_error FROM mcp_connections WHERE id = $1`,
				[id],
			);
			expect(row.rows[0].probe_error).toBe(ConnectorProbeError.AuthRequired);
			expect(row.rows[0].auth_error).toBeNull();
			expect((await loadConnectorsForRun(db, projectId)).some((r) => r.id === id)).toBe(false);
		} finally {
			await unauthorized.close();
		}
	});

	it('says when its own re-check could not reach the connector either', async () => {
		const gone = await startTestMcpHttpServer({ tools: TOOLS });
		const port = gone.port;
		await gone.close();
		const id = await seedConnector(`http://127.0.0.1:${port}/mcp`, 'api_key');
		const line = await recheckRejectedConnector(
			{ db, masterKeyManager: ctx.masterKeyManager },
			event({ connectorId: id, kind: 'upstream_unreachable', status: 0, reason: 'ECONNREFUSED' }),
			{ label: 'test', teamId, projectId },
		);
		expect(line).toContain("Hezo's re-check could not reach it either");
	});

	it('never rejects, even for a connector that no longer exists', async () => {
		const { broadcasts, wsManager } = recordingWs();
		const line = await recheckRejectedConnector(
			{ db, masterKeyManager: ctx.masterKeyManager, wsManager },
			event(),
			{ label: 'test', teamId, projectId },
		);
		expect(line).toContain('no longer exists');
		expect(broadcasts).toEqual([]);
	});
});

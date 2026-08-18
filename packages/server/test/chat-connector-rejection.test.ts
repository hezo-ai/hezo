import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatMessageStatus, ChatSystemMessageKind, DEFAULT_TEAM_ID } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import { ChatSessionManager } from '../src/services/chat-session-manager';
import type { ExecLogChunk } from '../src/services/docker';
import type { ConnectorRunRejection, RunProxyScope } from '../src/services/egress/proxy';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { getWorkspacePath } from '../src/services/workspace';
import { WebSocketManager } from '../src/services/ws';
import { createStubDocker, seedProjectContainer } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';
import { startTestMcpHttpServer, type TestMcpServer } from './helpers/test-mcp-http-server';

/**
 * The CEO chat's half of a connector refusal. A task run writes the two lines
 * into its log; a chat turn has no run log, so the same two sentences land as
 * system rows in the thread whose turn was in flight - the operator reads them
 * there and the CEO reads them back next turn. The proxy-side observation is
 * covered in `egress-connector-rejection.test.ts`; here the fake proxy hands the
 * event to whatever scope the session allocated with.
 */

const claudeLine = (obj: unknown) => `${JSON.stringify(obj)}\n`;
const assistantText = (text: string) =>
	claudeLine({
		type: 'assistant',
		message: { role: 'assistant', content: [{ type: 'text', text }] },
	});

async function poll(fn: () => Promise<boolean>, timeoutMs = 6000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error('poll timed out');
}

describe('CEO chat connector refusal notices', () => {
	let ctx: ServerTestContext;
	let hqProjectId: string;
	let refusing: TestMcpServer;
	let connectorId: string;

	beforeAll(async () => {
		ctx = await createTestContext();
		refusing = await startTestMcpHttpServer({ failWithStatus: 401 });
	});
	afterAll(async () => {
		await refusing.close();
		await destroyTestContext(ctx);
	});

	beforeEach(async () => {
		await ctx.db.query('DELETE FROM chat_messages');
		await ctx.db.query('DELETE FROM chat_sessions');
		await ctx.db.query('DELETE FROM chat_conversations');
		await ctx.db.query('DELETE FROM ai_provider_configs');
		await ctx.db.query('DELETE FROM mcp_connections');

		const key = ctx.masterKeyManager.getKey();
		if (!key) throw new Error('master key unavailable');
		await ctx.db.query(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('anthropic', 'api_key', 'test', $1, true, 'verified', 'claude-sonnet-4-6')`,
			[encrypt('sk-ant-test', key)],
		);
		const proj = await ctx.db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 AND is_internal = true`,
			[DEFAULT_TEAM_ID],
		);
		hqProjectId = proj.rows[0].id;
		await ctx.db.query('DELETE FROM container_pool_members WHERE project_id = $1', [hqProjectId]);
		await seedProjectContainer(ctx.db, hqProjectId, 'hq-container');

		// An api-key connector whose server refuses everything, so Hezo's re-check
		// confirms the credential is dead.
		const secret = await ctx.db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
			 VALUES ('MCP_IBKR_CHAT_KEY', $1, 'api_token'::secret_category, '{127.0.0.1}') RETURNING id`,
			[encrypt('live-key', key)],
		);
		const connector = await ctx.db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status, activated_at, api_key_secret_id)
			 VALUES ('ibkr', 'saas', $1::jsonb, 'installed', now(), $2) RETURNING id`,
			[JSON.stringify({ url: `http://127.0.0.1:${refusing.port}/mcp` }), secret.rows[0].id],
		);
		connectorId = connector.rows[0].id;
	});

	function rejection(): ConnectorRunRejection {
		return {
			connectorId,
			connectorName: 'ibkr',
			credentialed: true,
			kind: 'upstream_rejected',
			status: 401,
			reason: 'http_401',
			credentialSent: true,
		};
	}

	/** A docker stub whose reply exec has the proxy report the refusal mid-turn. */
	function makeDocker(egress: { scopes: RunProxyScope[] }) {
		const toHostPath = (containerPath: string) =>
			join(
				getWorkspacePath(ctx.dataDir, DEFAULT_TEAM_ID, hqProjectId),
				containerPath.replace(/^\/workspace\//, ''),
			);
		return createStubDocker({
			execCreate: async (_id: string, config: { Env?: string[] }) => {
				const promptEntry = (config.Env ?? []).find((e) => e.startsWith('HEZO_PROMPT_FILE='));
				const prompt = promptEntry
					? readFileSync(toHostPath(promptEntry.slice('HEZO_PROMPT_FILE='.length)), 'utf8')
					: '';
				return prompt.includes('Reply to the latest operator message as the CEO.')
					? 'exec-reply'
					: 'exec-side';
			},
			execStart: async (
				execId: string,
				opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> },
			) => {
				if (execId !== 'exec-reply') return { stdout: '', stderr: '' };
				egress.scopes[0]?.onConnectorRejection?.(rejection());
				await opts.onChunk?.({ stream: 'stdout', text: assistantText('Checked the portfolio.') });
				return { stdout: '', stderr: '' };
			},
		});
	}

	function fakeEgress() {
		const scopes: RunProxyScope[] = [];
		const reset: string[] = [];
		const proxy = {
			allocateRunProxy: async (_runId: string, scope: RunProxyScope) => {
				scopes.push(scope);
				return { proxyHost: 'host.docker.internal', proxyPort: 24999, token: null };
			},
			releaseRunProxy: async () => {},
			resetConnectorRejections: (runId: string) => {
				reset.push(runId);
			},
		};
		return { scopes, reset, proxy };
	}

	test('posts what the turn saw and what the re-check found as system rows in the thread', async () => {
		const egress = fakeEgress();
		const wsManager = new WebSocketManager();
		const logs = new LogStreamBroker();
		logs.setWsManager(wsManager);
		const manager = new ChatSessionManager({
			db: ctx.db,
			docker: makeDocker(egress),
			masterKeyManager: ctx.masterKeyManager,
			serverPort: 0,
			dataDir: ctx.dataDir,
			wsManager,
			logs,
			// biome-ignore lint/suspicious/noExplicitAny: a partial fake of the proxy class
			egressProxy: egress.proxy as any,
			egressCAPath: '/tmp/hezo-test-ca.crt',
		});
		const systemRows = (conversationId: string) =>
			ctx.db.query<{ content: string; system_kind: string | null }>(
				`SELECT content, system_kind FROM chat_messages
				 WHERE conversation_id = $1 AND role = 'system' ORDER BY created_at ASC`,
				[conversationId],
			);
		const turnDone = (assistantMessageId: string) =>
			poll(async () => {
				const r = await ctx.db.query<{ status: string }>(
					'SELECT status FROM chat_messages WHERE id = $1',
					[assistantMessageId],
				);
				return r.rows[0]?.status === ChatMessageStatus.Complete;
			});

		const { assistantMessageId, conversationId } = await manager.sendTurn({ text: 'status?' });
		await turnDone(assistantMessageId);
		// The re-check runs off the turn's critical path; wait for its verdict row.
		await poll(async () => (await systemRows(conversationId)).rows.length >= 2);
		// A second turn on the same session starts by forgetting what was reported.
		const second = await manager.sendTurn({ text: 'and now?' });
		await turnDone(second.assistantMessageId);
		await poll(async () => (await systemRows(conversationId)).rows.length >= 4);
		await manager.stop();

		const rows = await systemRows(conversationId);
		// Two turns, two rows each: the observation, then the verdict.
		expect(rows.rows).toHaveLength(4);
		expect(rows.rows.every((r) => r.system_kind === ChatSystemMessageKind.ConnectorRefused)).toBe(
			true,
		);
		expect(rows.rows[0].content).toContain(
			'connector "ibkr" refused this run\'s request (HTTP 401) although its credential was sent',
		);
		expect(rows.rows[1].content).toContain('no longer accepted');
		expect(rows.rows[1].content).toContain('reconnect');
		expect(egress.reset.length).toBeGreaterThanOrEqual(2);

		const health = await ctx.db.query<{ auth_error: string | null }>(
			`SELECT auth_error FROM mcp_connections WHERE id = $1`,
			[connectorId],
		);
		expect(health.rows[0].auth_error).toContain('401');
	});
});

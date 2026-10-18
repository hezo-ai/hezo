import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	ChatMessageRole,
	ChatMessageStatus,
	ChatSystemMessageKind,
	checkPromptStyle,
	DEFAULT_TEAM_ID,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRuntimeConfig, runtimeConfig, setRuntimeConfig } from '../src/config/runtime';
import { encrypt } from '../src/crypto/encryption';
import { getSystemMeta, setSystemMeta } from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { ChatSessionManager } from '../src/services/chat-session-manager';
import type { ExecLogChunk } from '../src/services/docker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import {
	deliverSeedBrief,
	pendingSeedBrief,
	releaseInterruptedSeedBrief,
	SEED_BRIEF_CONTEXT,
	SEED_BRIEF_SENDING,
	SEED_PROJECT_CONSUMED_KEY,
} from '../src/services/seed';
import { getWorkspacePath } from '../src/services/workspace';
import { WebSocketManager } from '../src/services/ws';
import { buildApp } from '../src/startup';
import { authHeader, createStubDocker, seedProjectContainer } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

// A hosted signup brief reaches the CEO chat on its own, as the admin's first
// message, once the CEO can answer it: when a model credential is stored.

const BRIEF = 'Track my portfolio and send me a weekly report — “short”, with one chart.';

const claudeLine = (obj: unknown) => `${JSON.stringify(obj)}\n`;

/** Replies to every CEO turn, and keeps each turn's prompt as the container read it. */
function promptCapturingDocker(dataDir: string, projectId: string) {
	const prompts: string[] = [];
	const toHostPath = (containerPath: string) =>
		join(
			getWorkspacePath(dataDir, DEFAULT_TEAM_ID, projectId),
			containerPath.replace(/^\/workspace\//, ''),
		);
	const docker = createStubDocker({
		execCreate: async (_id: string, config: { Env?: string[] }) => {
			const entry = (config.Env ?? []).find((e) => e.startsWith('HEZO_PROMPT_FILE='));
			if (entry) {
				prompts.push(readFileSync(toHostPath(entry.slice('HEZO_PROMPT_FILE='.length)), 'utf8'));
			}
			return 'exec-turn';
		},
		execStart: async (
			_id: string,
			opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> } = {},
		) => {
			const onChunk = opts.onChunk ?? (() => undefined);
			await onChunk({
				stream: 'stdout',
				text: claudeLine({
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'Let us plan it.' }] },
				}),
			});
			await onChunk({
				stream: 'stdout',
				text: claudeLine({ type: 'result', usage: { input_tokens: 10, output_tokens: 5 } }),
			});
			return { stdout: '', stderr: '' };
		},
	});
	return { docker, prompts };
}

describe('sending the seeded brief to the CEO chat', () => {
	let ctx: ServerTestContext;
	let hqProjectId: string;
	let manager: ChatSessionManager;
	let app: Hono<Env>;
	let prompts: string[];

	async function addCredential(): Promise<void> {
		const key = ctx.masterKeyManager.getKey();
		if (!key) throw new Error('master key unavailable');
		await ctx.db.query(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('anthropic', 'api_key', 'test', $1, true, 'verified', 'claude-sonnet-4-6')`,
			[encrypt('sk-ant-test', key)],
		);
	}

	/** The admin's messages in the HQ CEO chat, oldest first. */
	async function adminMessages() {
		const r = await ctx.db.query<{ content: string; author_user_id: string | null }>(
			`SELECT m.content, m.author_user_id FROM chat_messages m
			 JOIN chat_conversations c ON c.id = m.conversation_id
			 WHERE c.project_id = $1 AND m.role = $2
			 ORDER BY m.created_at`,
			[hqProjectId, ChatMessageRole.User],
		);
		return r.rows;
	}

	async function superuserId(): Promise<string> {
		const r = await ctx.db.query<{ id: string }>(
			'SELECT id FROM users WHERE is_superuser = true ORDER BY created_at LIMIT 1',
		);
		return r.rows[0].id;
	}

	beforeAll(async () => {
		ctx = await createTestContext();
		const hq = await ctx.db.query<{ id: string }>(
			'SELECT id FROM projects WHERE team_id = $1 AND is_internal = true',
			[DEFAULT_TEAM_ID],
		);
		hqProjectId = hq.rows[0].id;
		await seedProjectContainer(ctx.db, hqProjectId, 'hq-container');
	});

	afterAll(async () => {
		await destroyTestContext(ctx);
	});

	beforeEach(async () => {
		await ctx.db.query('DELETE FROM chat_memories');
		await ctx.db.query('DELETE FROM chat_messages');
		await ctx.db.query('DELETE FROM chat_sessions');
		await ctx.db.query('DELETE FROM chat_conversations');
		await ctx.db.query('DELETE FROM ai_provider_configs');
		await ctx.db.query('DELETE FROM system_meta WHERE key = $1', [SEED_PROJECT_CONSUMED_KEY]);
		setRuntimeConfig({ ...runtimeConfig(), seed: { project: { description: BRIEF } } });

		const capturing = promptCapturingDocker(ctx.dataDir, hqProjectId);
		prompts = capturing.prompts;
		const wsManager = new WebSocketManager();
		const logs = new LogStreamBroker();
		manager = new ChatSessionManager({
			db: ctx.db,
			docker: capturing.docker,
			masterKeyManager: ctx.masterKeyManager,
			serverPort: 0,
			dataDir: ctx.dataDir,
			wsManager,
			logs,
		});
		app = buildApp(
			ctx.db,
			ctx.masterKeyManager,
			{ dataDir: ctx.dataDir, webUrl: '' },
			capturing.docker,
			wsManager,
			undefined,
			logs,
			null,
			null,
			undefined,
			undefined,
			manager,
		);
	});

	afterEach(async () => {
		await manager.stop();
		resetRuntimeConfig();
	});

	it('sends the brief as typed, from the admin, and the CEO replies knowing it came from signup', async () => {
		await addCredential();
		expect(await deliverSeedBrief(ctx.db, manager)).toBe(true);

		expect(await adminMessages()).toEqual([
			{ content: BRIEF, author_user_id: await superuserId() },
		]);
		expect(await getSystemMeta(ctx.db, SEED_PROJECT_CONSUMED_KEY)).not.toBeNull();
		await vi.waitFor(async () => {
			const reply = await ctx.db.query<{ status: string; content: string }>(
				`SELECT status, content FROM chat_messages WHERE role = $1`,
				[ChatMessageRole.Assistant],
			);
			expect(reply.rows).toEqual([
				{ status: ChatMessageStatus.Complete, content: 'Let us plan it.' },
			]);
		});
		// The CEO's reply is told where the message came from; the stored message is
		// not. (The chat also titles the conversation, with a prompt of its own.)
		const turn = prompts.find((p) => p.includes(SEED_BRIEF_CONTEXT));
		expect(turn).toContain(BRIEF);

		// Sent once: a later trigger finds nothing to send.
		expect(await deliverSeedBrief(ctx.db, manager)).toBe(false);
		expect(await adminMessages()).toHaveLength(1);
	});

	it('waits, sending nothing, while no model credential is configured', async () => {
		expect(await deliverSeedBrief(ctx.db, manager)).toBe(false);
		expect(await adminMessages()).toEqual([]);
		expect(await getSystemMeta(ctx.db, SEED_PROJECT_CONSUMED_KEY)).toBeNull();
		expect(await pendingSeedBrief(ctx.db)).toBe(BRIEF);
	});

	it('sends the brief with the budget notice while the CEO is over its token budget', async () => {
		await addCredential();
		const ceo = await ctx.db.query<{ id: string }>(
			`SELECT m.id FROM members m JOIN member_agents ma ON ma.id = m.id
			 WHERE ma.slug = 'ceo' AND m.team_id = $1`,
			[DEFAULT_TEAM_ID],
		);
		const ceoId = ceo.rows[0].id;
		await ctx.db.query('UPDATE member_agents SET daily_budget_tokens = 1 WHERE id = $1', [ceoId]);
		await ctx.db.query(
			`INSERT INTO usage_entries (member_id, input_tokens, description) VALUES ($1, 5, 'prior')`,
			[ceoId],
		);
		try {
			// Shown like a message the admin typed: the brief stands, and the notice
			// under it says why the CEO cannot answer yet.
			expect(await deliverSeedBrief(ctx.db, manager)).toBe(true);
			expect(await adminMessages()).toEqual([
				{ content: BRIEF, author_user_id: await superuserId() },
			]);
			const notice = await ctx.db.query<{ system_kind: string | null }>(
				'SELECT system_kind FROM chat_messages WHERE role = $1',
				[ChatMessageRole.System],
			);
			expect(notice.rows).toEqual([{ system_kind: ChatSystemMessageKind.BudgetExceeded }]);
			expect(await getSystemMeta(ctx.db, SEED_PROJECT_CONSUMED_KEY)).not.toBeNull();
		} finally {
			await ctx.db.query('UPDATE member_agents SET daily_budget_tokens = 0 WHERE id = $1', [ceoId]);
			await ctx.db.query('DELETE FROM usage_entries WHERE member_id = $1', [ceoId]);
		}
	});

	it('sends nothing on an instance that was not seeded', async () => {
		resetRuntimeConfig();
		await addCredential();
		expect(await deliverSeedBrief(ctx.db, manager)).toBe(false);
		expect(await adminMessages()).toEqual([]);
	});

	it('sends the brief once when two triggers race', async () => {
		await addCredential();
		const sent = await Promise.all([
			deliverSeedBrief(ctx.db, manager),
			deliverSeedBrief(ctx.db, manager),
		]);
		expect(sent.filter(Boolean)).toHaveLength(1);
		expect(await adminMessages()).toHaveLength(1);
	});

	it('gives the claim back when the send fails, so the next trigger retries', async () => {
		await addCredential();
		const failing = {
			ceoTurnBlocker: async () => null,
			sendTurn: async () => {
				throw new Error('chat unavailable');
			},
		};
		await expect(deliverSeedBrief(ctx.db, failing)).rejects.toThrow('chat unavailable');
		expect(await getSystemMeta(ctx.db, SEED_PROJECT_CONSUMED_KEY)).toBeNull();
		expect(await pendingSeedBrief(ctx.db)).toBe(BRIEF);

		expect(await deliverSeedBrief(ctx.db, manager)).toBe(true);
		expect(await adminMessages()).toHaveLength(1);
	});

	it('stamps a finished send, so a boot never releases it', async () => {
		await addCredential();
		expect(await deliverSeedBrief(ctx.db, manager)).toBe(true);
		const stamp = await getSystemMeta(ctx.db, SEED_PROJECT_CONSUMED_KEY);
		expect(stamp).not.toBeNull();
		expect(stamp).not.toBe(SEED_BRIEF_SENDING);
		expect(await releaseInterruptedSeedBrief(ctx.db)).toBe(false);
		expect(await deliverSeedBrief(ctx.db, manager)).toBe(false);
		expect(await adminMessages()).toHaveLength(1);
	});

	it('sends the brief after a boot when the last run stopped mid-send', async () => {
		await addCredential();
		// The claim a run took just before it died, with no message stored.
		await setSystemMeta(ctx.db, SEED_PROJECT_CONSUMED_KEY, SEED_BRIEF_SENDING);
		expect(await deliverSeedBrief(ctx.db, manager)).toBe(false);

		expect(await releaseInterruptedSeedBrief(ctx.db)).toBe(true);
		expect(await deliverSeedBrief(ctx.db, manager)).toBe(true);
		expect(await adminMessages()).toEqual([
			{ content: BRIEF, author_user_id: await superuserId() },
		]);
	});

	it('does not send it twice when the last run stored it before it stopped', async () => {
		await addCredential();
		await setSystemMeta(ctx.db, SEED_PROJECT_CONSUMED_KEY, SEED_BRIEF_SENDING);
		const conversationId = await manager.getConversationId();
		await ctx.db.query(
			`INSERT INTO chat_messages (conversation_id, role, channel, status, content, author_user_id)
			 VALUES ($1, $2, 'web', 'complete', $3, $4)`,
			[conversationId, ChatMessageRole.User, BRIEF, await superuserId()],
		);

		expect(await releaseInterruptedSeedBrief(ctx.db)).toBe(true);
		expect(await deliverSeedBrief(ctx.db, manager)).toBe(false);
		expect(await adminMessages()).toHaveLength(1);
	});

	it('reports a failed lookup as an error, not as a reason to wait', async () => {
		await addCredential();
		// A database that drops the CEO's model lookup, as a lost connection would.
		const flaky = new Proxy(ctx.db, {
			get(target, prop) {
				if (prop !== 'query') return Reflect.get(target, prop);
				return (sql: string, params?: unknown[]) => {
					if (sql.includes('model_override_provider')) {
						return Promise.reject(new Error('connection reset'));
					}
					return target.query(sql, params);
				};
			},
		});
		const broken = new ChatSessionManager({
			db: flaky,
			docker: createStubDocker(),
			masterKeyManager: ctx.masterKeyManager,
			serverPort: 0,
			dataDir: ctx.dataDir,
			wsManager: new WebSocketManager(),
			logs: new LogStreamBroker(),
		});
		try {
			await expect(broken.ceoTurnBlocker()).rejects.toThrow('connection reset');
			await expect(deliverSeedBrief(ctx.db, broken)).rejects.toThrow('connection reset');
			expect(await getSystemMeta(ctx.db, SEED_PROJECT_CONSUMED_KEY)).toBeNull();
			expect(await pendingSeedBrief(ctx.db)).toBe(BRIEF);
		} finally {
			await broken.stop();
		}
	});

	it('tells the CEO in the house register', () => {
		expect(checkPromptStyle(SEED_BRIEF_CONTEXT)).toEqual([]);
	});

	/** A default credential the provider refused, as an upgraded instance may hold. */
	async function addRefusedDefault(): Promise<string> {
		const key = ctx.masterKeyManager.getKey();
		if (!key) throw new Error('master key unavailable');
		const r = await ctx.db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('anthropic', 'api_key', 'refused', $1, true, 'invalid', 'claude-sonnet-4-6')
			 RETURNING id`,
			[encrypt('sk-ant-old', key)],
		);
		return r.rows[0].id;
	}

	it('is sent once the admin replaces a refused default key', async () => {
		const configId = await addRefusedDefault();
		expect(await deliverSeedBrief(ctx.db, manager)).toBe(false);

		const prevSkip = process.env.SKIP_AI_KEY_VALIDATION;
		process.env.SKIP_AI_KEY_VALIDATION = '1';
		try {
			const res = await app.request(`/api/ai-providers/${configId}`, {
				method: 'PATCH',
				headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ api_key: 'sk-ant-new' }),
			});
			expect(res.status).toBe(200);
		} finally {
			process.env.SKIP_AI_KEY_VALIDATION = prevSkip;
		}
		expect((await adminMessages()).map((m) => m.content)).toEqual([BRIEF]);
	});

	it('is sent once the admin makes a working key the default', async () => {
		await addRefusedDefault();
		const key = ctx.masterKeyManager.getKey();
		if (!key) throw new Error('master key unavailable');
		const working = await ctx.db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('openai', 'api_key', 'working', $1, false, 'verified', 'gpt-5')
			 RETURNING id`,
			[encrypt('sk-openai-test', key)],
		);
		expect(await deliverSeedBrief(ctx.db, manager)).toBe(false);

		const res = await app.request(`/api/ai-providers/${working.rows[0].id}/default`, {
			method: 'PATCH',
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		expect((await adminMessages()).map((m) => m.content)).toEqual([BRIEF]);
	});

	it('is in the chat the admin lands on once they connect their first model', async () => {
		const prevSkip = process.env.SKIP_AI_KEY_VALIDATION;
		process.env.SKIP_AI_KEY_VALIDATION = '1';
		try {
			const created = await app.request('/api/ai-providers', {
				method: 'POST',
				headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ provider: 'anthropic', api_key: 'sk-ant-test', label: 'mine' }),
			});
			expect(created.status).toBe(201);
		} finally {
			process.env.SKIP_AI_KEY_VALIDATION = prevSkip;
		}

		const chat = await app.request('/api/chat/conversation', { headers: authHeader(ctx.token) });
		const { messages } = (await chat.json()).data as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(messages[0]).toMatchObject({ role: ChatMessageRole.User, content: BRIEF });
	});
});

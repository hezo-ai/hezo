// A chat turn carries the same plaintext values a task run does (the provider
// credential, a session token, egress and bridge tokens), and its reply is
// stored, broadcast and delivered to channels. Every one of those copies is
// masked, and what the turn wrote into its pooled container goes with it.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthType, ChatMessageStatus, DEFAULT_TEAM_ID, WsMessageType, wsRoom } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { encrypt } from '../src/crypto/encryption';
import { scrubRunArtifacts } from '../src/services/agent-runner';
import { ChatSessionManager } from '../src/services/chat-session-manager';
import type { ExecLogChunk } from '../src/services/docker';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { hostSandboxFiles } from '../src/services/sandbox/files';
import { getWorkspacePath } from '../src/services/workspace';
import type { WsSocket } from '../src/services/ws';
import { WebSocketManager } from '../src/services/ws';
import { createStubDocker, seedProjectContainer } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

// Long enough to clear the masker's floor; the other chat suites' key is not.
const PROVIDER_KEY = 'sk-ant-api03-chat-masking-0123456789';

const claudeLine = (obj: unknown) => `${JSON.stringify(obj)}\n`;
const assistantText = (text: string) =>
	claudeLine({
		type: 'assistant',
		message: { role: 'assistant', content: [{ type: 'text', text }] },
	});
const resultEvent = claudeLine({ type: 'result', usage: { input_tokens: 3, output_tokens: 2 } });

async function poll(fn: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 15));
	}
	throw new Error('poll timed out');
}

/** Everything an open chatbox receives, joining each conversation's room as it appears. */
function captureChat(wsManager: WebSocketManager): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	const joined = new Set<string>();
	const socket: WsSocket = {
		data: { auth: { type: AuthType.Admin, isSuperuser: true }, rooms: new Set() },
		send: (msg: string) => {
			const event = JSON.parse(msg) as Record<string, unknown>;
			events.push(event);
			const convoId = event.conversationId;
			if (typeof convoId === 'string' && !joined.has(convoId)) {
				joined.add(convoId);
				wsManager.subscribe(socket, wsRoom.chatConversation(convoId));
			}
		},
	};
	wsManager.subscribe(socket, wsRoom.chat());
	return events;
}

describe('chat turn secrets', () => {
	let ctx: ServerTestContext;
	let projectId: string;

	beforeAll(async () => {
		ctx = await createTestContext();
	});
	afterAll(async () => {
		await destroyTestContext(ctx);
	});
	beforeEach(async () => {
		await ctx.db.query('DELETE FROM chat_messages');
		await ctx.db.query('DELETE FROM chat_sessions');
		await ctx.db.query('DELETE FROM chat_conversations');
		await ctx.db.query('DELETE FROM ai_provider_configs');
		const key = ctx.masterKeyManager.getKey();
		if (!key) throw new Error('master key unavailable');
		await ctx.db.query(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('anthropic', 'api_key', 'test', $1, true, 'verified', 'claude-sonnet-4-6')`,
			[encrypt(PROVIDER_KEY, key)],
		);
		const proj = await ctx.db.query<{ id: string }>(
			'SELECT id FROM projects WHERE team_id = $1 AND is_internal = true',
			[DEFAULT_TEAM_ID],
		);
		projectId = proj.rows[0].id;
		await ctx.db.query('DELETE FROM container_pool_members WHERE project_id = $1', [projectId]);
		await seedProjectContainer(ctx.db, projectId, 'hq-container');
	});

	test('masks the key and the session token in the stored, streamed and completed reply', async () => {
		let replyEnv: string[] = [];
		const kinds = new Map<string, 'prompt' | 'aux'>();
		let seq = 0;
		const docker = createStubDocker({
			execCreate: async (_id: string, config: { Env?: string[] }) => {
				const execId = `exec-${++seq}`;
				const env = config.Env ?? [];
				const prompt = env.find((e) => e.startsWith('HEZO_PROMPT_FILE='));
				const isReply =
					prompt !== undefined &&
					readFileSync(
						join(
							getWorkspacePath(ctx.dataDir, DEFAULT_TEAM_ID, projectId),
							prompt.slice('HEZO_PROMPT_FILE='.length).replace(/^\/workspace\//, ''),
						),
						'utf8',
					).includes('Reply to the latest operator message');
				kinds.set(execId, isReply ? 'prompt' : 'aux');
				if (isReply) replyEnv = env;
				return execId;
			},
			execStart: async (
				execId: string,
				opts: { onChunk?: (c: ExecLogChunk) => void | Promise<void> },
			) => {
				if (kinds.get(execId) !== 'prompt') return { stdout: '', stderr: '' };
				const onChunk = opts.onChunk ?? (() => undefined);
				const token =
					replyEnv.find((e) => e.startsWith('HEZO_AGENT_TOKEN='))?.slice(17) ?? 'missing-token';
				// The key arrives split across two deltas, as a token-sized stream does.
				await onChunk({
					stream: 'stdout',
					text: assistantText(`key ${PROVIDER_KEY.slice(0, 12)}`),
				});
				await onChunk({
					stream: 'stdout',
					text: assistantText(`${PROVIDER_KEY.slice(12)} token ${token} done`),
				});
				await onChunk({ stream: 'stdout', text: resultEvent });
				return { stdout: '', stderr: '' };
			},
		});
		const wsManager = new WebSocketManager();
		const logs = new LogStreamBroker();
		logs.setWsManager(wsManager);
		const manager = new ChatSessionManager({
			db: ctx.db,
			docker,
			masterKeyManager: ctx.masterKeyManager,
			serverPort: 0,
			dataDir: ctx.dataDir,
			wsManager,
			logs,
		});
		const events = captureChat(wsManager);
		try {
			const { assistantMessageId } = await manager.sendTurn({ text: 'print your env' });
			await poll(async () => {
				const r = await ctx.db.query<{ status: string }>(
					'SELECT status FROM chat_messages WHERE id = $1',
					[assistantMessageId],
				);
				return r.rows[0]?.status === ChatMessageStatus.Complete;
			});

			const token = replyEnv.find((e) => e.startsWith('HEZO_AGENT_TOKEN='))?.slice(17) ?? '';
			expect(token.length).toBeGreaterThan(20);

			const stored = await ctx.db.query<{ content: string }>(
				'SELECT content FROM chat_messages WHERE id = $1',
				[assistantMessageId],
			);
			// The two deltas join into one value, masked whole.
			expect(stored.rows[0].content).toBe('key *** token *** done');

			const streamed = events
				.filter((e) => e.type === WsMessageType.ChatMessageDelta)
				.map((e) => String(e.text))
				.join('');
			const completed = events
				.filter((e) => e.type === WsMessageType.ChatMessageComplete)
				.map((e) => String(e.content))
				.join('');
			for (const text of [streamed, completed]) {
				expect(text).not.toContain(PROVIDER_KEY.slice(0, 12));
				expect(text).not.toContain(PROVIDER_KEY.slice(12));
				expect(text).not.toContain(token);
			}

			// The turn's tunnel config went with the turn: the container is pooled.
			const tunnelDir = join(
				getWorkspacePath(ctx.dataDir, DEFAULT_TEAM_ID, projectId),
				'.hezo',
				'tunnel',
			);
			const left = existsSync(tunnelDir) ? readdirSync(tunnelDir) : [];
			expect(left.filter((f) => f.endsWith('.json'))).toEqual([]);
		} finally {
			await manager.stop();
		}
	});
});

describe('scrubRunArtifacts', () => {
	test("removes a turn's token-bearing home config, its home dir and its tunnel config", async () => {
		const root = mkdtempSync(join(tmpdir(), 'hezo-scrub-'));
		const docker = createStubDocker({
			files: (_containerId: string, containerRoot: string) =>
				hostSandboxFiles(join(root, containerRoot)),
		});
		const mcpConfig = join(root, 'home', 'node', '.gemini', 'config', 'mcp_config.json');
		const homeDir = join(root, 'workspace', '.hezo', 'subscription', 'agy', 'turn-1');
		const tunnelConfig = join(root, 'workspace', '.hezo', 'tunnel', 'turn-1.json');
		mkdirSync(join(mcpConfig, '..'), { recursive: true });
		writeFileSync(mcpConfig, '{"headers":{"Authorization":"Bearer secret"}}');
		mkdirSync(homeDir, { recursive: true });
		writeFileSync(join(homeDir, 'auth.json'), '{"token":"secret"}');
		mkdirSync(join(tunnelConfig, '..'), { recursive: true });
		writeFileSync(tunnelConfig, '{}');

		const steps: string[] = [];
		await scrubRunArtifacts(
			docker,
			{
				containerId: 'c-1',
				runUser: { name: 'node', uid: 1000, gid: 1000 },
				homeConfigScrubPaths: ['.gemini/config/mcp_config.json'],
				homeDir: '/workspace/.hezo/subscription/agy/turn-1',
				tunnelConfigId: 'turn-1',
			},
			async (label, fn) => {
				steps.push(label);
				await fn();
			},
		);

		expect(steps).toEqual(['scrub-home-config', 'remove-tunnel-config', 'remove-home-mount']);
		expect(existsSync(mcpConfig)).toBe(false);
		expect(existsSync(homeDir)).toBe(false);
		expect(existsSync(tunnelConfig)).toBe(false);
	});
});

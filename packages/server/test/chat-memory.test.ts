import {
	CEO_AGENT_SLUG,
	DEFAULT_MAX_CHAT_HISTORY_SIZE,
	DEFAULT_TEAM_ID,
	HQ_PROJECT_SLUG,
	MAX_CHAT_HISTORY_SIZE_MAX,
	MAX_CHAT_HISTORY_SIZE_MIN,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import {
	clampMaxChatHistorySize,
	getMaxChatHistorySize,
	setMaxChatHistorySize,
} from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import {
	buildCompactionPrompt,
	formatLongTermMemoryBlock,
} from '../src/services/ceo-session-manager';
import {
	getChatMemory,
	loadActiveWindow,
	markCompacted,
	selectFlush,
	upsertChatMemory,
} from '../src/services/chat-memory';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	instanceCeoId,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let nonSuperuserToken: string;
let ceoMemberId: string;
let hqProjectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const nonAdmin = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Regular Admin', false) RETURNING id",
	);
	nonSuperuserToken = await signAdminJwt(ctx.masterKeyManager, nonAdmin.rows[0].id);

	ceoMemberId = await instanceCeoId(db);
	const hq = await db.query<{ id: string }>(
		'SELECT id FROM projects WHERE team_id = $1 AND is_internal = true',
		[DEFAULT_TEAM_ID],
	);
	hqProjectId = hq.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('selectFlush', () => {
	const msg = (id: string, bytes: number) => ({ id, bytes, line: `${id}: x` });

	it('reports overCap and evicts everything but the latest few', () => {
		const messages = [msg('a', 30), msg('b', 30), msg('c', 30), msg('d', 30)];
		const r = selectFlush(messages, 50, 2);
		expect(r.overCap).toBe(true);
		// Everything except the latest 2 is evicted.
		expect(r.evictIds).toEqual(['a', 'b']);
		// The transcript is the whole window, oldest→newest.
		expect(r.windowTranscript).toBe('a: x\n\nb: x\n\nc: x\n\nd: x');
	});

	it('is not over cap when the window fits', () => {
		const messages = [msg('a', 10), msg('b', 10)];
		const r = selectFlush(messages, 50, 2);
		expect(r.overCap).toBe(false);
		expect(r.evictIds).toEqual([]);
	});

	it('never evicts the retained tail even when it alone exceeds the cap', () => {
		const messages = [msg('a', 100), msg('b', 100)];
		const r = selectFlush(messages, 50, 2);
		expect(r.overCap).toBe(true);
		// Only 2 messages and retain is 2 → nothing to evict.
		expect(r.evictIds).toEqual([]);
	});
});

describe('formatLongTermMemoryBlock', () => {
	it('renders the body under a Long-term memory heading', () => {
		const block = formatLongTermMemoryBlock('- Operator prefers terse replies');
		expect(block).toContain('## Long-term memory');
		expect(block).toContain('- Operator prefers terse replies');
	});

	it('shows a placeholder when empty', () => {
		expect(formatLongTermMemoryBlock('   ')).toContain('nothing recorded yet');
	});
});

describe('buildCompactionPrompt', () => {
	it('embeds the current memory and window and instructs update_chat_memory', () => {
		const prompt = buildCompactionPrompt('existing notes', 'Operator: hi\n\nCEO: hello');
		expect(prompt).toContain('update_chat_memory');
		expect(prompt).toContain('existing notes');
		expect(prompt).toContain('Operator: hi');
		expect(prompt).toContain('CEO: hello');
	});

	it('marks empty memory explicitly', () => {
		expect(buildCompactionPrompt('   ', 'Operator: hi')).toContain('_(empty)_');
	});
});

describe('chat_memories store + active window', () => {
	let conversationId: string;

	beforeAll(async () => {
		const c = await db.query<{ id: string }>(
			`INSERT INTO ceo_conversations (member_id, team_id) VALUES ($1, $2) RETURNING id`,
			[ceoMemberId, DEFAULT_TEAM_ID],
		);
		conversationId = c.rows[0].id;
	});

	it('upserts and reads back memory, bumping updated_at on rewrite', async () => {
		const first = await upsertChatMemory(db, ceoMemberId, 'v1');
		expect(first.content).toBe('v1');
		const got = await getChatMemory(db, ceoMemberId);
		expect(got?.content).toBe('v1');
		const second = await upsertChatMemory(db, ceoMemberId, 'v2');
		expect(second.content).toBe('v2');
		expect(second.updated_at).not.toBe(first.updated_at);
	});

	it('loadActiveWindow returns only complete, non-empty, non-compacted messages oldest→newest', async () => {
		const ins = async (role: string, status: string, content: string) => {
			const r = await db.query<{ id: string }>(
				`INSERT INTO ceo_messages (conversation_id, role, channel, status, content)
				 VALUES ($1, $2::ceo_message_role, 'web', $3::ceo_message_status, $4) RETURNING id`,
				[conversationId, role, status, content],
			);
			return r.rows[0].id;
		};
		const m1 = await ins('user', 'complete', 'first');
		await ins('assistant', 'streaming', ''); // placeholder — excluded
		const m3 = await ins('assistant', 'complete', 'reply');

		const window = await loadActiveWindow(db, conversationId);
		expect(window.map((m) => m.id)).toEqual([m1, m3]);
		expect(window.map((m) => m.content)).toEqual(['first', 'reply']);

		// Compacting m1 removes it from the window.
		await markCompacted(db, [m1]);
		const after = await loadActiveWindow(db, conversationId);
		expect(after.map((m) => m.id)).toEqual([m3]);
	});

	it('markCompacted is a no-op for an empty id list', async () => {
		await expect(markCompacted(db, [])).resolves.toBeUndefined();
	});
});

describe('max_chat_history_size setting', () => {
	it('falls back to the default when unset', async () => {
		expect(await getMaxChatHistorySize(db)).toBe(DEFAULT_MAX_CHAT_HISTORY_SIZE);
	});

	it('clamps stored values to the allowed range', () => {
		expect(clampMaxChatHistorySize(1)).toBe(MAX_CHAT_HISTORY_SIZE_MIN);
		expect(clampMaxChatHistorySize(10_000_000)).toBe(MAX_CHAT_HISTORY_SIZE_MAX);
		expect(clampMaxChatHistorySize(40 * 1024)).toBe(40 * 1024);
	});

	it('reads back a stored value', async () => {
		await setMaxChatHistorySize(db, 64 * 1024);
		expect(await getMaxChatHistorySize(db)).toBe(64 * 1024);
	});

	it('GET /api/instance-settings returns max_chat_history_size', async () => {
		const res = await app.request('/api/instance-settings', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		expect((await res.json()).data.max_chat_history_size).toBe(64 * 1024);
	});

	it('PATCH (superuser) updates and echoes max_chat_history_size', async () => {
		const res = await app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ max_chat_history_size: 32 * 1024 }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.max_chat_history_size).toBe(32 * 1024);
		expect(await getMaxChatHistorySize(db)).toBe(32 * 1024);
	});

	it('rejects a non-superuser PATCH', async () => {
		const res = await app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(nonSuperuserToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ max_chat_history_size: 16 * 1024 }),
		});
		expect(res.status).toBe(403);
	});

	it('rejects an out-of-range value', async () => {
		const res = await app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ max_chat_history_size: 999_999_999 }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('rejects a non-integer value', async () => {
		const res = await app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ max_chat_history_size: 'lots' }),
		});
		expect(res.status).toBe(400);
	});
});

describe('update_chat_memory MCP tool', () => {
	it('lets the CEO overwrite its own long-term memory', async () => {
		const { token: ceo } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoMemberId,
			DEFAULT_TEAM_ID,
			null,
			{
				projectId: hqProjectId,
			},
		);
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(ceo), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'update_chat_memory', arguments: { content: 'remember: ship fast' } },
				id: 1,
			}),
		});
		const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
		const parsed = JSON.parse(body.result.content[0].text) as { written?: boolean };
		expect(parsed.written).toBe(true);
		const stored = await getChatMemory(db, ceoMemberId);
		expect(stored?.content).toBe('remember: ship fast');
	});
});

describe('agent chat-memory REST route', () => {
	beforeAll(async () => {
		// Ensure the CEO is chat-enabled (has a conversation).
		await db.query(
			`INSERT INTO ceo_conversations (member_id, team_id)
			 SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM ceo_conversations WHERE member_id = $1)`,
			[ceoMemberId, DEFAULT_TEAM_ID],
		);
	});

	it('GET returns the CEO long-term memory', async () => {
		await upsertChatMemory(db, ceoMemberId, 'curated notes');
		const res = await app.request(
			`/api/projects/${HQ_PROJECT_SLUG}/agents/${CEO_AGENT_SLUG}/chat-memory`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		expect((await res.json()).data.content).toBe('curated notes');
	});

	it('PUT (superuser) edits the memory', async () => {
		const res = await app.request(
			`/api/projects/${HQ_PROJECT_SLUG}/agents/${CEO_AGENT_SLUG}/chat-memory`,
			{
				method: 'PUT',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: 'operator edit' }),
			},
		);
		expect(res.status).toBe(200);
		expect((await res.json()).data.content).toBe('operator edit');
		expect((await getChatMemory(db, ceoMemberId))?.content).toBe('operator edit');
	});

	it('PUT rejects a non-superuser', async () => {
		const res = await app.request(
			`/api/projects/${HQ_PROJECT_SLUG}/agents/${CEO_AGENT_SLUG}/chat-memory`,
			{
				method: 'PUT',
				headers: { ...authHeader(nonSuperuserToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: 'nope' }),
			},
		);
		expect(res.status).toBe(403);
	});

	it('404s for an agent with no chatbox', async () => {
		const teamRes = await createTestTeam(db, { name: 'Plain Co' });
		const teamId = (await teamRes.json()).data.id;
		const proj = (await (await createTestProject(db, teamId, { name: 'Plain Project' })).json())
			.data;
		// The Captain of a normal project is not chat-enabled.
		const res = await app.request(`/api/projects/${proj.slug}/agents/captain/chat-memory`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});

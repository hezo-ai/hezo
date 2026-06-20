import type { PGlite } from '@electric-sql/pglite';
import {
	CHAT_HISTORY_LIMIT_MAX,
	CHAT_HISTORY_LIMIT_MIN,
	CHAT_MEMORY_SLUG,
	DEFAULT_CHAT_HISTORY_LIMIT,
	DEFAULT_TEAM_ID,
	HQ_PROJECT_SLUG,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	clampChatHistoryLimit,
	getChatHistoryLimit,
	setChatHistoryLimit,
} from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { formatChatMemoryBlock } from '../src/services/ceo-session-manager';
import { ensureChatMemoryDoc } from '../src/services/teams';
import { resolveSystemPrompt } from '../src/services/template-resolver';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let nonSuperuserToken: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const nonAdmin = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Regular Admin', false) RETURNING id",
	);
	nonSuperuserToken = await signAdminJwt(ctx.masterKeyManager, nonAdmin.rows[0].id);
});

afterAll(async () => {
	await safeClose(db);
});

async function hqProjectId(): Promise<string> {
	const r = await db.query<{ id: string }>(
		'SELECT id FROM projects WHERE team_id = $1 AND is_internal = true',
		[DEFAULT_TEAM_ID],
	);
	return r.rows[0].id;
}

describe('chat-memory seeding', () => {
	it('seeds an empty chat-memory.md project_doc in the HQ project', async () => {
		const r = await db.query<{ content: string; title: string; type: string }>(
			'SELECT content, title, type FROM documents WHERE project_id = $1 AND slug = $2',
			[await hqProjectId(), CHAT_MEMORY_SLUG],
		);
		expect(r.rows).toHaveLength(1);
		expect(r.rows[0].type).toBe('project_doc');
		expect(r.rows[0].content).toBe('');
		expect(r.rows[0].title).toBe('Chatbox memory');
	});
});

describe('ensureChatMemoryDoc', () => {
	it('recreates the doc if it is missing and is idempotent', async () => {
		const projectId = await hqProjectId();
		// Simulate an instance that predates the feature.
		await db.query('DELETE FROM documents WHERE project_id = $1 AND slug = $2', [
			projectId,
			CHAT_MEMORY_SLUG,
		]);
		await ensureChatMemoryDoc(db);
		await ensureChatMemoryDoc(db);
		const r = await db.query('SELECT 1 FROM documents WHERE project_id = $1 AND slug = $2', [
			projectId,
			CHAT_MEMORY_SLUG,
		]);
		expect(r.rows).toHaveLength(1);
	});
});

describe('formatChatMemoryBlock', () => {
	it('renders the content under a Chatbox memory heading', () => {
		const block = formatChatMemoryBlock('- Operator prefers terse replies');
		expect(block).toContain('## Chatbox memory');
		expect(block).toContain('- Operator prefers terse replies');
		expect(block).toContain(CHAT_MEMORY_SLUG);
	});

	it('shows a placeholder when empty so the agent knows the facility exists', () => {
		const block = formatChatMemoryBlock('   ');
		expect(block).toContain('## Chatbox memory');
		expect(block).toContain('nothing recorded yet');
	});
});

describe('chat-memory manifest exclusion', () => {
	it('omits chat-memory.md from the HQ {{project_docs_context}} manifest', async () => {
		const projectId = await hqProjectId();
		// Seed a normal HQ doc so the manifest is non-empty and we can prove the
		// reserved doc is the only thing excluded.
		await db.query(
			`INSERT INTO documents (project_id, team_id, type, slug, title, content)
			 VALUES ($1, $2, 'project_doc', 'notes.md', 'Notes', '# Notes')`,
			[projectId, DEFAULT_TEAM_ID],
		);
		const resolved = await resolveSystemPrompt(db, '{{project_docs_context}}', {
			teamId: DEFAULT_TEAM_ID,
			projectId,
		});
		expect(resolved).toContain('notes.md');
		expect(resolved).not.toContain(CHAT_MEMORY_SLUG);
	});
});

describe('chat-memory delete guard', () => {
	it('rejects deleting chat-memory.md from the HQ project (403)', async () => {
		const res = await app.request(`/api/projects/${HQ_PROJECT_SLUG}/docs/${CHAT_MEMORY_SLUG}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe('FORBIDDEN');
		// Still present afterwards.
		const r = await db.query('SELECT 1 FROM documents WHERE project_id = $1 AND slug = $2', [
			await hqProjectId(),
			CHAT_MEMORY_SLUG,
		]);
		expect(r.rows).toHaveLength(1);
	});

	it('allows deleting a normal doc from the HQ project', async () => {
		await app.request(`/api/projects/${HQ_PROJECT_SLUG}/docs/scratch.md`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# scratch' }),
		});
		const res = await app.request(`/api/projects/${HQ_PROJECT_SLUG}/docs/scratch.md`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
	});

	it('does not guard a same-named doc in a non-HQ project', async () => {
		const teamRes = await createTestTeam(db, { name: 'Other Co' });
		const teamSlug = (await teamRes.json()).data.slug as string;
		const projRes = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ team: teamSlug, name: 'Side Project', description: 'x'.repeat(20) }),
		});
		const projectSlug = (await projRes.json()).data.slug as string;
		await app.request(`/api/projects/${projectSlug}/docs/${CHAT_MEMORY_SLUG}`, {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: '# not the reserved one' }),
		});
		const res = await app.request(`/api/projects/${projectSlug}/docs/${CHAT_MEMORY_SLUG}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
	});
});

describe('chat history limit setting', () => {
	it('falls back to the default when unset', async () => {
		expect(await getChatHistoryLimit(db)).toBe(DEFAULT_CHAT_HISTORY_LIMIT);
	});

	it('clamps stored values to the allowed range', () => {
		expect(clampChatHistoryLimit(5)).toBe(CHAT_HISTORY_LIMIT_MIN);
		expect(clampChatHistoryLimit(10_000)).toBe(CHAT_HISTORY_LIMIT_MAX);
		expect(clampChatHistoryLimit(120)).toBe(120);
	});

	it('reads back a stored value', async () => {
		await setChatHistoryLimit(db, 150);
		expect(await getChatHistoryLimit(db)).toBe(150);
	});

	it('GET /api/instance-settings returns the chat_history_limit', async () => {
		const res = await app.request('/api/instance-settings', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		expect((await res.json()).data.chat_history_limit).toBe(150);
	});

	it('PATCH (superuser) updates the chat_history_limit and echoes it', async () => {
		const res = await app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_history_limit: 42 }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.chat_history_limit).toBe(42);
		expect(await getChatHistoryLimit(db)).toBe(42);
	});

	it('rejects a non-superuser PATCH', async () => {
		const res = await app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(nonSuperuserToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_history_limit: 99 }),
		});
		expect(res.status).toBe(403);
	});

	it('rejects an out-of-range chat_history_limit', async () => {
		const res = await app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_history_limit: 9999 }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});

	it('rejects a non-integer chat_history_limit', async () => {
		const res = await app.request('/api/instance-settings', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_history_limit: 'lots' }),
		});
		expect(res.status).toBe(400);
	});
});

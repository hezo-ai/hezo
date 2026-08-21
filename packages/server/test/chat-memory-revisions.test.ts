// Coverage for the chat-memory revision routes and service. Chat memory is the
// one memory surface whose write is automatic (window compaction rewrites it
// whole), so its history and its guards are what make a bad compaction
// recoverable — these drive the branches that decide who may read and restore.

import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { listChatMemoryRevisions, upsertChatMemory } from '../src/services/chat-memory';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
let chatAgentId: string;
let plainAgentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Chat Memory Co' });
	const team = (await teamRes.json()).data as { id: string };
	projectSlug = await projectSlugFor(db, team.id);

	const agents = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 ORDER BY ma.slug LIMIT 1`,
		[team.id],
	);
	chatAgentId = agents.rows[0].id;

	// A second agent that is deliberately NOT chat-enabled. Created explicitly
	// rather than picked from the roster: the seeded team may hold only one agent,
	// and falling back to the chat-enabled one would make the 404 case vacuous.
	const plain = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'agent', 'No Chat Agent') RETURNING id`,
		[team.id],
	);
	plainAgentId = plain.rows[0].id;
	await db.query(`INSERT INTO member_agents (id, title, slug) VALUES ($1, $2, $3)`, [
		plainAgentId,
		'No Chat Agent',
		'no-chat-agent',
	]);

	// Only a chat-enabled agent (one with a conversation) has chat memory.
	await db.query(
		`INSERT INTO chat_conversations (member_id, team_id, project_id)
		 VALUES ($1, $2, (SELECT id FROM projects WHERE team_id = $2 LIMIT 1))`,
		[chatAgentId, team.id],
	);
	await db.query(`INSERT INTO chat_memories (member_id, content) VALUES ($1, $2)`, [
		chatAgentId,
		'operator deploys on Tuesdays',
	]);
});

afterAll(async () => {
	await safeClose(db);
});

const memUrl = (agentId: string, suffix = '') =>
	`/api/projects/${projectSlug}/agents/${agentId}/chat-memory${suffix}`;

describe('chat memory revisions', () => {
	it('records the prior content on a change, and attributes the operator', async () => {
		const res = await app.request(memUrl(chatAgentId), {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'operator deploys on Thursdays' }),
		});
		expect(res.status).toBe(200);

		const revs = await app.request(memUrl(chatAgentId, '/revisions'), {
			headers: authHeader(token),
		});
		expect(revs.status).toBe(200);
		const rows = (await revs.json()).data as {
			revision_number: number;
			content: string;
			author_type: string;
			author_name: string | null;
		}[];
		expect(rows).toHaveLength(1);
		// The row holds what the write REPLACED, not what it wrote.
		expect(rows[0].content).toBe('operator deploys on Tuesdays');
		expect(rows[0].revision_number).toBe(1);
		// An operator edit is distinguishable from an automatic compaction.
		expect(rows[0].author_type).toBe('admin');
		expect(rows[0].author_name).toBeTruthy();
	});

	it('records nothing for a no-op write', async () => {
		const before = (await listChatMemoryRevisions(db, chatAgentId)).length;
		await app.request(memUrl(chatAgentId), {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'operator deploys on Thursdays' }),
		});
		// An unchanged UPDATE still leaves a dead tuple under MVCC, and a revision
		// saying "identical to the one before it" is noise in the operator's history.
		expect(await listChatMemoryRevisions(db, chatAgentId)).toHaveLength(before);
	});

	it('attributes the agent when it compacts its own memory', async () => {
		await upsertChatMemory(db, chatAgentId, 'compacted by the agent', 'window compaction');
		const rows = await listChatMemoryRevisions(db, chatAgentId);
		expect(rows[0].author_type).toBe('agent');
		expect(rows[0].change_summary).toBe('window compaction');
	});

	it('restores a past version as a new current one, keeping the timeline', async () => {
		const before = (await listChatMemoryRevisions(db, chatAgentId)).length;
		const res = await app.request(memUrl(chatAgentId, '/restore'), {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ revision_number: 1 }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.content).toBe('operator deploys on Tuesdays');

		// Append-only: the restore is itself a change, so it snapshots what it
		// replaced rather than rewinding the history.
		const after = await listChatMemoryRevisions(db, chatAgentId);
		expect(after.length).toBe(before + 1);
		expect(after[0].change_summary).toBe('Restored content from revision 1');
	});

	it('404s revisions for an agent that has no chat memory', async () => {
		const res = await app.request(memUrl(plainAgentId, '/revisions'), {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('404s revisions for an unknown agent', async () => {
		const res = await app.request(memUrl('00000000-0000-0000-0000-000000000000', '/revisions'), {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('400s a restore with no revision_number', async () => {
		const res = await app.request(memUrl(chatAgentId, '/restore'), {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it('404s a restore of a revision that does not exist', async () => {
		const res = await app.request(memUrl(chatAgentId, '/restore'), {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ revision_number: 9999 }),
		});
		expect(res.status).toBe(404);
	});

	it('refuses a write over the cap, and stores nothing', async () => {
		const priorRes = await app.request(memUrl(chatAgentId), { headers: authHeader(token) });
		const prior = (await priorRes.json()).data.content as string;

		const res = await app.request(memUrl(chatAgentId), {
			method: 'PUT',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content: 'x'.repeat(12_001) }),
		});
		expect(res.status).toBe(400);
		// The refusal has to converge: compaction is what drains the message window,
		// so the message names the ceiling and the size rather than dead-ending.
		const msg = (await res.json()).error.message as string;
		expect(msg).toContain('12000');
		expect(msg).toContain('12001');
		expect(msg).toMatch(/consolidate/i);

		const after = await app.request(memUrl(chatAgentId), { headers: authHeader(token) });
		expect((await after.json()).data.content).toBe(prior);
	});
});

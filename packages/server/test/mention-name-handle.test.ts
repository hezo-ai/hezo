import { CommentContentType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { fireCommentWakeups, resolveWarnableSlugs } from '../src/services/comment-wakeups';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;

let teamId: string;
let projectId: string;
let projectSlug: string;
let engineerId: string;
let architectId: string;
let captainId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const res = await app.request('/api/projects', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Mention Handles Co',
			description: 'Build the app.',
			marketplace_slug: 'app-dev',
		}),
	});
	const project = (await res.json()).data as { id: string; slug: string; team_id: string };
	projectId = project.id;
	projectSlug = project.slug;
	teamId = project.team_id;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	engineerId = agents.find((a) => a.slug === 'engineer')!.id;
	architectId = agents.find((a) => a.slug === 'architect')!.id;
	captainId = agents.find((a) => a.slug === 'captain')!.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function insertTask(assigneeId: string, title: string): Promise<string> {
	const meta = await db.query<{ task_prefix: string; number: number }>(
		`SELECT p.task_prefix, next_project_task_number(p.id) AS number
		 FROM projects p WHERE p.id = $1`,
		[projectId],
	);
	const n = meta.rows[0].number;
	const res = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
		 RETURNING id`,
		[teamId, projectId, assigneeId, n, `${meta.rows[0].task_prefix}-${n}`, title],
	);
	return res.rows[0].id;
}

/** Fire the fan-out for a comment body and report who it actually woke. */
async function wokeBy(content: string, authorMemberId: string): Promise<string[]> {
	const taskId = await insertTask(captainId, `Task for ${content.slice(0, 20)}`);
	const comment = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb) RETURNING id`,
		[taskId, authorMemberId, JSON.stringify({ text: content })],
	);
	const woke = await fireCommentWakeups({
		db,
		teamId,
		taskId,
		commentId: comment.rows[0].id,
		content,
		contentType: CommentContentType.Text,
		authorMemberId,
	});
	return [...woke].sort();
}

/**
 * An agent answers to two handles: the slug of its role and the slug of its
 * name. Both have to wake it, or the name is decoration - an author who writes
 * the name they see in the UI would be talking to nobody.
 */
describe('mentioning an agent by its human name', () => {
	it('wakes the agent by name and by role alike', async () => {
		// Nobody arrives named, so the second handle has to be created first - which
		// is exactly the state this is about: an agent an admin has named.
		const named = await app.request(`/api/projects/${projectSlug}/agents/engineer`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ human_name: 'Max' }),
		});
		expect(named.status).toBe(200);

		expect(await wokeBy('@max can you take this?', architectId)).toEqual(['max']);
		expect(await wokeBy('@engineer can you take this?', architectId)).toEqual(['engineer']);
	});

	it('follows a rename, and drops the handle the agent no longer answers to', async () => {
		await app.request(`/api/projects/${projectSlug}/agents/engineer`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ human_name: 'Wren' }),
		});

		expect(await wokeBy('@wren over to you', architectId)).toEqual(['wren']);
		// The role handle is permanent, so it keeps working.
		expect(await wokeBy('@engineer over to you', architectId)).toEqual(['engineer']);
		// The old name is nobody's now.
		expect(await wokeBy('@max over to you', architectId)).toEqual([]);
	});

	it('never wakes an agent by its own name', async () => {
		expect(await wokeBy('@wren talking to myself', engineerId)).toEqual([]);
	});

	it('treats both handles as known teammates, so neither reads as an unlinked name', async () => {
		const roster = await resolveWarnableSlugs(db, teamId, architectId);
		expect(roster).toContain('engineer');
		expect(roster).toContain('wren');
	});
});

describe('the mention picker', () => {
	// The team ships nobody named, so the name half of the picker needs one made
	// the way a human makes it - which is also what the test is really about.
	beforeAll(async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents/ui-designer`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ human_name: 'Mia' }),
		});
		if (res.status !== 200) throw new Error(`naming the UI Designer failed: ${res.status}`);
	});

	async function search(q: string) {
		const res = await app.request(
			`/api/projects/${projectSlug}/mentions/search?q=${encodeURIComponent(q)}&kind=agent`,
			{ headers: authHeader(token) },
		);
		return (await res.json()).data as Array<{ handle: string; label: string; sublabel: string }>;
	}

	it('finds an agent by the role someone is looking for, and offers its name', async () => {
		const results = await search('design');
		const designer = results.find((r) => r.label === 'Mia');
		expect(designer).toBeTruthy();
		// Searching a role hands back the handle the person is known by.
		expect(designer?.handle).toBe('mia');
		expect(designer?.sublabel).toContain('UI Designer');
	});

	it('finds an agent by name', async () => {
		const results = await search('mi');
		expect(results.some((r) => r.label === 'Mia' && r.handle === 'mia')).toBe(true);
	});

	it('still offers the role handle for an agent with no name', async () => {
		const results = await search('captain');
		const captain = results.find((r) => r.handle === 'captain');
		expect(captain?.label).toBe('Captain');
		expect(captain?.sublabel).toBe('@captain');
	});
});

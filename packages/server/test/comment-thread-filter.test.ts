import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

// `list_comments` returns the conversation and the task's own changes by default
// and leaves out the one-marker-per-execution run rows, which on a long-lived
// task are the bulk of the thread and carry nothing the thread does not. These
// cover the filter, the `since` window, and the excerpt width being narrowed to
// fit a page rather than the page being rejected.

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
let taskId: string;
let textId: string;
let systemId: string;
let runId: string;

async function callTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: 'list_comments', arguments: { project: projectSlug, ...args } },
			id: 1,
		}),
	});
	const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
	return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
}

function itemIds(page: Record<string, unknown>): string[] {
	return (page.items as Array<{ id: string }>).map((i) => i.id);
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Thread Filter Co' });
	const teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Thread Filter Project' });
	const project = (await projectRes.json()).data;
	projectSlug = project.slug;

	const task = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, number, identifier, title)
		 VALUES ($1, $2, 4100, 'TF-4100', 'Standing check') RETURNING id`,
		[teamId, project.id],
	);
	taskId = task.rows[0].id;

	const seed = async (type: string, content: unknown, at: string): Promise<string> => {
		const r = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content, created_at)
			 VALUES ($1, $2::comment_content_type, $3::jsonb, $4::timestamptz) RETURNING id`,
			[taskId, type, JSON.stringify(content), at],
		);
		return r.rows[0].id;
	};
	textId = await seed('text', { text: 'Round one shipped.' }, '2026-01-02T09:00:00Z');
	systemId = await seed(
		'system',
		{ kind: 'status_change', text: 'moved to in_progress' },
		'2026-01-02T10:00:00Z',
	);
	runId = await seed('run', { run_id: null, agent_slug: 'captain' }, '2026-01-02T11:00:00Z');
});

afterAll(() => safeClose(db));

describe('list_comments row categories', () => {
	it('returns the conversation and the task events, not the run markers', async () => {
		const page = await callTool({ task_id: taskId });
		expect(itemIds(page).sort()).toEqual([systemId, textId].sort());
		expect(page.categories_applied).toEqual(['conversation', 'events']);
	});

	it('returns run markers when asked for them', async () => {
		const page = await callTool({ task_id: taskId, categories: ['runs'] });
		expect(itemIds(page)).toEqual([runId]);
		expect(page.categories_applied).toEqual(['runs']);
	});

	it('returns the whole thread when every category is asked for', async () => {
		const page = await callTool({
			task_id: taskId,
			categories: ['conversation', 'events', 'runs'],
		});
		expect(itemIds(page).sort()).toEqual([runId, systemId, textId].sort());
	});

	it('narrows to the conversation alone', async () => {
		const page = await callTool({ task_id: taskId, categories: ['conversation'] });
		expect(itemIds(page)).toEqual([textId]);
	});
});

describe('list_comments since', () => {
	it('returns only what is newer, and composes with the category default', async () => {
		const page = await callTool({ task_id: taskId, since: '2026-01-02T09:30:00Z' });
		// The run marker is newer still but excluded by the default categories.
		expect(itemIds(page)).toEqual([systemId]);
	});

	it('returns nothing when the thread has not moved since', async () => {
		const page = await callTool({ task_id: taskId, since: '2026-02-01T00:00:00Z' });
		expect(page.items).toEqual([]);
		expect(page.has_more).toBe(false);
	});

	// The value is cast to timestamptz, so an unparseable one would otherwise fail
	// inside the statement and read as an internal error rather than a bad argument.
	it('rejects a since it cannot parse, naming what to send', async () => {
		const page = await callTool({ task_id: taskId, since: 'last tuesday' });
		expect(String(page.error)).toContain('Invalid since');
		expect(String(page.error)).toContain('ISO-8601');
	});
});

describe('list_comments excerpt width', () => {
	it('narrows the excerpt to what a page of that size can carry', async () => {
		const wide = await callTool({ task_id: taskId, limit: 50, excerpt_chars: 2000 });
		// 50 rows at 2000 characters cannot fit the result cap, so the width is
		// reduced rather than the page being rejected whole.
		expect(wide.excerpt_chars_applied as number).toBeLessThan(2000);
		expect(wide.items).toBeDefined();

		const narrow = await callTool({ task_id: taskId, limit: 5, excerpt_chars: 2000 });
		expect(narrow.excerpt_chars_applied).toBe(2000);
	});

	it('never widens a caller that asked for less', async () => {
		const page = await callTool({ task_id: taskId, limit: 50, excerpt_chars: 100 });
		expect(page.excerpt_chars_applied).toBe(100);
	});
});

// The REST twin takes the same two parameters but defaults to every row: the web
// app folds the machinery itself and counts the run and system rows to label each
// folded group, so a filtered default would silently empty those chips.
describe('the REST comments feed', () => {
	async function get(query: string): Promise<{ status: number; ids: string[] }> {
		const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskId}/comments${query}`, {
			headers: authHeader(token),
		});
		if (res.status !== 200) return { status: res.status, ids: [] };
		const body = (await res.json()) as { data: Array<{ id: string }> };
		return { status: res.status, ids: body.data.map((c) => c.id) };
	}

	it('returns every row by default, in both full and skeleton mode', async () => {
		expect((await get('')).ids.sort()).toEqual([runId, systemId, textId].sort());
		expect((await get('?view=skeleton')).ids.sort()).toEqual([runId, systemId, textId].sort());
	});

	it('narrows when asked, on both modes', async () => {
		expect((await get('?categories=conversation')).ids).toEqual([textId]);
		expect((await get('?view=skeleton&categories=runs')).ids).toEqual([runId]);
		expect((await get('?since=2026-01-02T09:30:00Z')).ids.sort()).toEqual([systemId, runId].sort());
	});

	it('rejects a selection it cannot honour rather than narrowing silently', async () => {
		expect((await get('?categories=logs')).status).toBe(400);
		expect((await get('?since=whenever')).status).toBe(400);
	});

	// Body mode is keyed by explicit ids, so honouring a filter there would answer
	// a different question from the one asked.
	it('ignores the filter in body mode', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments?ids=${runId}&categories=conversation`,
			{ headers: authHeader(token) },
		);
		const body = (await res.json()) as { data: Array<{ id: string }> };
		expect(body.data.map((c) => c.id)).toEqual([runId]);
	});
});

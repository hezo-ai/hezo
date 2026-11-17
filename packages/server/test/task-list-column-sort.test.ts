import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

// The task list's column sorts (title, status, priority, assignee) and its search
// over the assignee's name. Tasks are inserted directly so no agent run is
// dispatched: a queued run would lift a task into the top band and reorder it
// ahead of the field under test. Every assertion reads only this file's tasks,
// since project setup can seed tasks of its own.

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
const ids: Record<string, string> = {};
const OWN = new Set<string>();

async function addAgent(teamId: string, title: string, slug: string, humanName: string | null) {
	const m = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'agent', $2) RETURNING id`,
		[teamId, title],
	);
	await db.query(
		`INSERT INTO member_agents (id, title, slug, human_name) VALUES ($1, $2, $3, $4)`,
		[m.rows[0].id, title, slug, humanName],
	);
	return m.rows[0].id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamId = (await (await createTestTeam(db, { name: 'Column Sort Co' })).json()).data
		.id as string;
	const project = (
		await (await createTestProject(db, teamId, { name: 'Column Sort', description: 'x' })).json()
	).data;
	projectSlug = project.slug;

	// "Ada" is a human name over the Researcher title; Zed Writer has none, so its
	// title is its display name.
	const ada = await addAgent(teamId, 'Researcher', 'column-sort-researcher', 'Ada');
	const zed = await addAgent(teamId, 'Zed Writer', 'column-sort-zed', null);

	const rows: [string, string, string, string, string | null][] = [
		// key, title, status, priority, assignee
		['banana', 'banana', 'backlog', 'low', zed],
		['apple', 'Apple', 'done', 'urgent', null],
		['cherry', 'cherry', 'blocked', 'medium', ada],
		['date', 'Date', 'in_progress', 'high', zed],
		['elder', 'elder', 'cancelled', 'medium', null],
		['fig', 'fig', 'backlog', 'high', ada],
	];
	let n = 9001;
	for (const [key, title, status, priority, assignee] of rows) {
		const r = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, assignee_id)
       VALUES ($1, $2, $3, $4, $5, $6::task_status, $7::task_priority, $8) RETURNING id`,
			[teamId, project.id, n, `CS-${n}`, title, status, priority, assignee],
		);
		ids[key] = r.rows[0].id;
		OWN.add(r.rows[0].id);
		n++;
	}
});

afterAll(async () => {
	await safeClose(db);
});

async function list(query: string): Promise<{ data: { id: string }[]; meta: { total: number } }> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks?per_page=100&${query}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	return res.json();
}

/** This file's task keys, in the order the list returned them. */
async function order(query: string): Promise<string[]> {
	const byId = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
	const body = await list(query);
	return body.data.filter((t) => OWN.has(t.id)).map((t) => byId.get(t.id) as string);
}

describe('task list column sorts', () => {
	it('sorts by title, ignoring case, both ways', async () => {
		expect(await order('sort=title:asc')).toEqual([
			'apple',
			'banana',
			'cherry',
			'date',
			'elder',
			'fig',
		]);
		expect(await order('sort=title:desc')).toEqual([
			'fig',
			'elder',
			'date',
			'cherry',
			'banana',
			'apple',
		]);
	});

	it('sorts by status in lifecycle order, ties by task number', async () => {
		// banana (9001) and fig (9006) share backlog, so the number breaks the tie.
		expect(await order('sort=status:asc')).toEqual([
			'banana',
			'fig',
			'date',
			'cherry',
			'apple',
			'elder',
		]);
		expect(await order('sort=status:desc')).toEqual([
			'elder',
			'apple',
			'cherry',
			'date',
			'banana',
			'fig',
		]);
	});

	it('sorts by priority with urgent first ascending', async () => {
		expect(await order('sort=priority:asc')).toEqual([
			'apple',
			'date',
			'fig',
			'cherry',
			'elder',
			'banana',
		]);
		expect(await order('sort=priority:desc')).toEqual([
			'banana',
			'cherry',
			'elder',
			'date',
			'fig',
			'apple',
		]);
	});

	it('sorts by assignee display name with unassigned tasks last both ways', async () => {
		expect(await order('sort=assignee:asc')).toEqual([
			'cherry',
			'fig',
			'banana',
			'date',
			'apple',
			'elder',
		]);
		expect(await order('sort=assignee:desc')).toEqual([
			'banana',
			'date',
			'cherry',
			'fig',
			'apple',
			'elder',
		]);
	});

	it('pages a tied sort without repeating or skipping a task', async () => {
		const seen: string[] = [];
		const byId = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
		for (let page = 1; ; page++) {
			const res = await app.request(
				`/api/projects/${projectSlug}/tasks?sort=status:asc&search=CS-90&per_page=2&page=${page}`,
				{ headers: authHeader(token) },
			);
			const body = (await res.json()) as { data: { id: string }[] };
			if (body.data.length === 0) break;
			seen.push(...body.data.map((t) => byId.get(t.id) as string));
		}
		expect(seen).toEqual(['banana', 'fig', 'date', 'cherry', 'apple', 'elder']);
	});
});

describe('task list search by agent', () => {
	it('matches the assignee human name, case-insensitively', async () => {
		const body = await list('search=ada');
		const own = body.data.filter((t) => OWN.has(t.id)).map((t) => t.id);
		expect(own.sort()).toEqual([ids.cherry, ids.fig].sort());
		expect(body.meta.total).toBe(body.data.length);
	});

	it('matches the assignee title when the agent has no human name', async () => {
		const body = await list('search=Zed%20Writer');
		const own = body.data.filter((t) => OWN.has(t.id)).map((t) => t.id);
		expect(own.sort()).toEqual([ids.banana, ids.date].sort());
	});

	it('matches the assignee slug', async () => {
		const body = await list('search=column-sort-researcher');
		expect(body.data.map((t) => t.id).sort()).toEqual([ids.cherry, ids.fig].sort());
		expect(body.meta.total).toBe(2);
	});

	it('still matches by task ID', async () => {
		const body = await list('search=CS-9004');
		expect(body.data.map((t) => t.id)).toEqual([ids.date]);
	});
});

import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Db } from '../src/db/database';
import { appendRunLogChunks, readRunLogWindow } from '../src/db/run-log-chunks';
import type { Env } from '../src/lib/types';
import {
	decodeCursor,
	encodeCursor,
	keysetOrderBy,
	keysetPredicate,
	MAX_LIST_LIMIT,
	pagedList,
	parseListLimit,
	windowContent,
} from '../src/mcp/paging';
import { oversizeRemedies } from '../src/mcp/tools';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Paging Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, {
		name: 'Paging Project',
		description: 'paging',
	});
	projectId = (await projectRes.json()).data.id;
	const agent = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'engineer'`,
		[teamId],
	);
	agentId = agent.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

async function callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
	return JSON.parse(body.result.content[0].text);
}

type Page = {
	items: Array<Record<string, unknown>>;
	next_cursor: string | null;
	has_more: boolean;
	paging_hint?: string;
};

/** Follow a tool's cursor to exhaustion, returning every row it ever yielded. */
async function walkAll(
	toolName: string,
	args: Record<string, unknown>,
	limit: number,
): Promise<Array<Record<string, unknown>>> {
	const seen: Array<Record<string, unknown>> = [];
	let cursor: string | null = null;
	// Bounded so a cursor that fails to advance fails the test instead of hanging.
	for (let i = 0; i < 50; i++) {
		const page = (await callTool(toolName, {
			...args,
			limit,
			...(cursor ? { cursor } : {}),
		})) as Page;
		seen.push(...page.items);
		if (!page.has_more) return seen;
		expect(page.next_cursor).toBeTruthy();
		cursor = page.next_cursor;
	}
	throw new Error(`${toolName} cursor never exhausted - it is not advancing`);
}

describe('paging helpers', () => {
	it('round-trips a cursor through the shared encode/decode', () => {
		const iso = '2026-01-02T03:04:05.000Z';
		const decoded = decodeCursor(encodeCursor(iso, 'abc-123'));
		expect(decoded).toEqual({ value: iso, id: 'abc-123' });
	});

	it('normalizes a Date sort column to ISO when building a cursor', () => {
		// The row comes back from the driver as a Date; the cursor half has to be
		// the ISO form, or the `::timestamptz` bind on the next page misreads it.
		const rows = [
			{ id: 'a', created_at: new Date('2026-03-01T00:00:00.000Z') },
			{ id: 'b', created_at: new Date('2026-02-01T00:00:00.000Z') },
		];
		const page = pagedList(rows, 1, 'demo');
		expect(decodeCursor(page.next_cursor ?? undefined)).toEqual({
			value: '2026-03-01T00:00:00.000Z',
			id: 'a',
		});
	});

	it('treats a malformed cursor as "start from the beginning" rather than erroring', () => {
		// A read that 500s on a bad cursor is worse than one that returns page 1:
		// the caller can still see has_more and recover.
		expect(decodeCursor('no-separator-here')).toBeNull();
		expect(decodeCursor('')).toBeNull();
		expect(decodeCursor(undefined)).toBeNull();
		expect(decodeCursor('|leading')).toBeNull();
		expect(decodeCursor('trailing|')).toBeNull();
	});

	it('preserves an id containing the separator character', () => {
		const decoded = decodeCursor(encodeCursor('2026-01-01T00:00:00.000Z', 'we|ird'));
		expect(decoded?.id).toBe('ird');
		// Documents the split-on-last-pipe behaviour: ids are UUIDs/slugs in
		// practice, so this is a known, harmless edge rather than a silent bug.
	});

	it('clamps limit into range and falls back to the default', () => {
		expect(parseListLimit(undefined)).toBe(50);
		expect(parseListLimit('12')).toBe(50);
		expect(parseListLimit(0)).toBe(1);
		expect(parseListLimit(-5)).toBe(1);
		expect(parseListLimit(10_000)).toBe(MAX_LIST_LIMIT);
		expect(parseListLimit(7.9)).toBe(7);
	});

	it('derives has_more from the over-fetch probe without counting', () => {
		const rows = Array.from({ length: 4 }, (_, i) => ({
			id: `id-${i}`,
			created_at: `2026-01-0${i + 1}T00:00:00.000Z`,
		}));
		const full = pagedList(rows, 3, 'demo');
		expect(full.items).toHaveLength(3);
		expect(full.has_more).toBe(true);
		expect(decodeCursor(full.next_cursor ?? undefined)?.id).toBe('id-2');
		expect(full.paging_hint).toContain('demo');

		const last = pagedList(rows.slice(0, 2), 3, 'demo');
		expect(last.has_more).toBe(false);
		expect(last.next_cursor).toBeNull();
		expect(last.paging_hint).toBeUndefined();
	});

	it('builds a keyset predicate and a matching ORDER BY', () => {
		const params: unknown[] = ['team'];
		const sql = keysetPredicate('t', decodeCursor(encodeCursor('2026-01-01', 'u1')), params);
		expect(sql).toBe('(t.created_at, t.id) < ($2::timestamptz, $3::uuid)');
		expect(params).toHaveLength(3);
		expect(keysetOrderBy('t')).toBe('t.created_at DESC, t.id DESC');
	});

	it('flips comparison and order together for an ascending sort', () => {
		// The predicate and the ORDER BY must agree, or rows are skipped or
		// repeated at every page boundary.
		const opts = { column: 'name', direction: 'asc', cast: 'text' } as const;
		const params: unknown[] = [];
		expect(keysetPredicate('c', decodeCursor(encodeCursor('Acme', 'u1')), params, opts)).toBe(
			'(c.name, c.id) > ($1::text, $2::uuid)',
		);
		expect(keysetOrderBy('c', opts)).toBe('c.name ASC, c.id ASC');
	});

	it('keys the tiebreak off a second alias when the sort column lives on a join', () => {
		const params: unknown[] = [];
		const sql = keysetPredicate('ma', decodeCursor(encodeCursor('Engineer', 'u1')), params, {
			column: 'title',
			direction: 'asc',
			cast: 'text',
			idAlias: 'm',
		});
		expect(sql).toBe('(ma.title, m.id) > ($1::text, $2::uuid)');
	});

	it('returns null predicate when there is no cursor, binding nothing', () => {
		const params: unknown[] = ['only'];
		expect(keysetPredicate('t', null, params)).toBeNull();
		expect(params).toEqual(['only']);
	});
});

describe('windowContent', () => {
	const build = (w: { content: string }) => w;
	const hint = () => 'more';

	it('returns short content whole with no continuation', () => {
		const out = windowContent({
			text: 'hello',
			limit: 64_000,
			reserve: 4_096,
			build,
			hint,
		}) as Record<string, unknown>;
		expect(out.content).toBe('hello');
		expect(out.next_offset).toBeNull();
		expect(out.truncated).toBe(false);
	});

	it('never splits a multi-byte character at a window edge', () => {
		// Each emoji is 4 bytes; a naive byte slice at 10 would cut one in half
		// and produce a replacement character.
		const text = '😀'.repeat(20);
		const first = windowContent({
			text,
			maxBytes: 10,
			limit: 64_000,
			reserve: 0,
			build,
			hint,
		}) as Record<string, unknown>;
		expect(first.content).toBe('😀😀');
		expect(first.returned_bytes).toBe(8);
		expect(first.next_offset).toBe(8);
		expect(String(first.content)).not.toContain('�');
	});

	it('walks a large body to completion via next_offset', () => {
		const text = 'x'.repeat(5_000);
		const seen: string[] = [];
		let offset: number | null = 0;
		for (let i = 0; i < 20 && offset !== null; i++) {
			const w = windowContent({
				text,
				offset,
				maxBytes: 1_000,
				limit: 64_000,
				reserve: 0,
				build,
				hint,
			}) as Record<string, unknown>;
			seen.push(w.content as string);
			offset = w.next_offset as number | null;
		}
		expect(offset).toBeNull();
		expect(seen.join('')).toBe(text);
	});

	it('shrinks the window until the serialized result fits the cap', () => {
		// Content whose JSON escaping inflates it well past its byte length, so
		// a byte-accurate window would still serialize over the limit.
		const text = '"\n'.repeat(4_000);
		const out = windowContent({
			text,
			limit: 3_000,
			reserve: 100,
			build: (w) => ({ ...w, padding: 'p'.repeat(500) }),
			hint,
		}) as Record<string, unknown>;
		expect(Buffer.byteLength(JSON.stringify(out, null, 2), 'utf8')).toBeLessThanOrEqual(3_000);
		expect(out.next_offset).not.toBeNull();
	});
});

describe('list tools page instead of silently truncating', () => {
	it('walks every task via the cursor with no duplicates or omissions', async () => {
		const created: string[] = [];
		for (let i = 0; i < 12; i++) {
			const t = (await callTool('create_task', {
				project: projectId,
				title: `Paged task ${i}`,
				description: 'body',
				assignee_id: agentId,
			})) as { identifier?: string };
			if (t.identifier) created.push(t.identifier);
		}

		const first = (await callTool('list_tasks', { project: projectId, limit: 5 })) as Page;
		expect(first.items).toHaveLength(5);
		expect(first.has_more).toBe(true);
		expect(first.next_cursor).toBeTruthy();
		expect(first.paging_hint).toContain('list_tasks');

		const all = await walkAll('list_tasks', { project: projectId }, 5);
		const ids = all.map((t) => t.id as string);
		expect(new Set(ids).size).toBe(ids.length);
		for (const identifier of created) {
			expect(all.some((t) => t.identifier === identifier)).toBe(true);
		}
	});

	it('bounds row width by excerpting long task text by default', async () => {
		const long = 'lorem '.repeat(2_000);
		await callTool('create_task', {
			project: projectId,
			title: 'Very long body',
			description: long,
			assignee_id: agentId,
		});
		const page = (await callTool('list_tasks', { project: projectId, limit: 50 })) as Page;
		const row = page.items.find((t) => t.title === 'Very long body');
		expect(row).toBeDefined();
		// The unbounded column is gone, replaced by an excerpt plus a size hint.
		expect(row).not.toHaveProperty('description');
		expect(row?.description_truncated).toBe(true);
		expect(row?.description_length).toBe(long.length);
	});

	it('pages a project roster and reaches every agent', async () => {
		const all = await walkAll('list_agents', { project: projectId }, 2);
		const slugs = all.map((a) => a.slug as string);
		expect(new Set(slugs).size).toBe(slugs.length);
		expect(slugs).toContain('engineer');
		expect(slugs).toContain('captain');
	});

	it('pages comments and returns them all', async () => {
		const task = (await callTool('create_task', {
			project: projectId,
			title: 'Comment thread',
			description: 'body',
			assignee_id: agentId,
		})) as { identifier: string };
		for (let i = 0; i < 7; i++) {
			await callTool('create_comment', {
				project: projectId,
				task_id: task.identifier,
				content: `comment ${i}`,
			});
		}
		const all = await walkAll('list_comments', { project: projectId, task_id: task.identifier }, 3);
		const ids = all.map((c) => c.id as string);
		expect(new Set(ids).size).toBe(ids.length);
		expect(all.length).toBeGreaterThanOrEqual(7);
	});

	it('reports docs with a size hint instead of their bodies', async () => {
		await callTool('write_project_doc', {
			project: projectId,
			filename: 'big.md',
			content: 'z'.repeat(9_000),
			changelog: 'seed',
		});
		const page = (await callTool('list_project_docs', { project: projectId })) as Page;
		const doc = page.items.find((d) => d.filename === 'big.md');
		expect(doc).toBeDefined();
		expect(doc).not.toHaveProperty('content');
		expect(doc?.content_length).toBe(9_000);
	});
});

describe('get_run_log reaches the start of a log, not only its tail', () => {
	async function seedRun(logText: string): Promise<string> {
		const r = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, exit_code, started_at)
			 VALUES ($1, $2, 'succeeded', 0, now()) RETURNING id`,
			[teamId, agentId],
		);
		const runId = r.rows[0].id;
		await appendRunLogChunks(db, runId, logText);
		return runId;
	}

	it('defaults to the tail and says the head was not returned', async () => {
		const head = 'FATAL: could not clone repository\n';
		const runId = await seedRun(head + 'noise\n'.repeat(5_000));
		const res = (await callTool('get_run_log', { project: projectId, run_id: runId })) as {
			log: string;
			truncated: boolean;
			paging_hint?: string;
		};
		expect(res.truncated).toBe(true);
		expect(res.log).not.toContain('FATAL');
		// The tail read must advertise the escape hatch, or the head stays lost.
		expect(res.paging_hint).toContain('offset: 0');
	});

	it('returns the head when asked, which the tail default can never do', async () => {
		const head = 'FATAL: could not clone repository\n';
		const runId = await seedRun(head + 'noise\n'.repeat(5_000));
		const res = (await callTool('get_run_log', {
			project: projectId,
			run_id: runId,
			offset: 0,
			max_bytes: 200,
		})) as { log: string; offset: number; next_offset: number | null };
		expect(res.log.startsWith(head)).toBe(true);
		expect(res.offset).toBe(0);
		expect(res.next_offset).toBe(200);
	});

	it('walks a whole log via next_offset with no gaps', async () => {
		const text = Array.from({ length: 200 }, (_, i) => `line-${i}\n`).join('');
		const runId = await seedRun(text);
		let offset: number | null = 0;
		const parts: string[] = [];
		for (let i = 0; i < 40 && offset !== null; i++) {
			const res = (await callTool('get_run_log', {
				project: projectId,
				run_id: runId,
				offset,
				max_bytes: 100,
			})) as { log: string; next_offset: number | null };
			parts.push(res.log);
			offset = res.next_offset;
		}
		expect(offset).toBeNull();
		expect(parts.join('')).toBe(text);
	});

	it('reads a window spanning several stored chunks', async () => {
		const runId = await seedRun('');
		for (let i = 0; i < 5; i++) await appendRunLogChunks(db, runId, `chunk${i}-`);
		const w = await readRunLogWindow(db, runId, 3, 20);
		expect(w.text).toBe('nk0-chunk1-chunk2-ch');
		expect(w.length).toBe(35);
		expect(w.nextOffset).toBe(23);
	});

	it('clamps an offset past the end instead of erroring', async () => {
		const runId = await seedRun('short');
		const w = await readRunLogWindow(db, runId, 9_999, 100);
		expect(w.text).toBe('');
		expect(w.nextOffset).toBeNull();
	});
});

describe('batch prompt reads chunk instead of failing whole', () => {
	it('returns a partial page with next_index and covers the roster when followed', async () => {
		const roster = (await callTool('list_agents', { project: projectId, limit: 50 })) as Page;
		const items = roster.items.map((a) => ({ agent_id: a.slug as string, mode: 'preview' }));
		expect(items.length).toBeGreaterThan(2);

		const seen: string[] = [];
		let startIndex: number | null = 0;
		for (let i = 0; i < 30 && startIndex !== null; i++) {
			const page = (await callTool('get_agent_system_prompts', {
				project: projectId,
				items,
				start_index: startIndex,
			})) as {
				error?: string;
				items: Array<Record<string, unknown>>;
				next_index: number | null;
				total: number;
			};
			// The whole point: a full-roster preview batch must never come back as
			// result_too_large, which is what sent a CEO run to one call per agent.
			expect(page.error).toBeUndefined();
			expect(page.items.length).toBeGreaterThan(0);
			expect(page.total).toBe(items.length);
			for (const row of page.items) seen.push(String(row.slug ?? row.agent_id));
			startIndex = page.next_index;
		}
		expect(startIndex).toBeNull();
		expect(seen).toHaveLength(items.length);
		expect(new Set(seen).size).toBe(items.length);
	});

	it('always advances, even when one prompt alone exceeds the cap', async () => {
		const captain = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[teamId],
		);
		await db.query(
			`UPDATE documents SET content = $2
			 WHERE type = 'agent_system_prompt' AND member_agent_id = $1`,
			[captain.rows[0].id, 'W'.repeat(200_000)],
		);
		const page = (await callTool('get_agent_system_prompts', {
			project: projectId,
			items: [
				{ agent_id: 'captain', mode: 'raw' },
				{ agent_id: 'engineer', mode: 'raw' },
			],
		})) as { items: Array<Record<string, unknown>>; next_index: number | null };
		expect(page.items).toHaveLength(1);
		expect(page.items[0].truncated).toBe(true);
		// A stalled cursor would loop the caller forever; it must move on.
		expect(page.next_index).toBe(1);
	});
});

describe('result_too_large names remedies the called tool actually has', () => {
	// The regression this whole change exists for: the old hint was a fixed
	// string naming four remedies, three of which do not exist on
	// get_agent_system_prompts. The only one that did was "fetch a single
	// resource via get_*", so an overflowing 10-agent batch became 10 calls.
	const shape = (keys: string[]): Record<string, z.ZodType> =>
		Object.fromEntries(keys.map((k) => [k, z.string().optional()]));

	it('gives a batch tool a concrete retry size and forbids the one-at-a-time fallback', () => {
		const remedies = oversizeRemedies(
			'get_agent_system_prompts',
			shape(['project', 'items']),
			{ items: Array.from({ length: 10 }, () => ({ agent_id: 'x' })) },
			205_939,
			131_072,
			'items',
		);
		const joined = remedies.join(' ');
		expect(joined).toContain('you sent 10 items');
		expect(joined).toContain('Do NOT fall back to one item per call');
		// 10 * 131072 * 0.8 / 205939 = 5.09 -> 5 per call, 2 calls.
		expect(joined).toContain('retry as 2 calls of at most 5');
		// Never advertise a knob this tool does not have.
		expect(joined).not.toContain('excerpt_chars');
		expect(joined).not.toContain('`before`');
	});

	it('scales the suggested batch size with how far over the cap the result was', () => {
		const modest = oversizeRemedies(
			'create_tasks',
			shape(['items']),
			{ items: Array.from({ length: 20 }, () => ({})) },
			70_000,
			64_000,
			'items',
		).join(' ');
		const massive = oversizeRemedies(
			'create_tasks',
			shape(['items']),
			{ items: Array.from({ length: 20 }, () => ({})) },
			640_000,
			64_000,
			'items',
		).join(' ');
		expect(modest).toContain('at most 14');
		expect(massive).toContain('at most 1');
	});

	it('offers cursor paging on a paged list tool, and not parameters it lacks', () => {
		const joined = oversizeRemedies(
			'list_tasks',
			shape(['project', 'status', 'excerpt_chars', 'limit', 'cursor']),
			{ project: 'p' },
			90_000,
			64_000,
		).join(' ');
		expect(joined).toContain('page with `cursor`');
		expect(joined).toContain('excerpt_chars');
		expect(joined).toContain('`status`');
		expect(joined).not.toContain('`before`');
		expect(joined).not.toContain('`offset`');
	});

	it('offers the byte window on a content reader', () => {
		const joined = oversizeRemedies(
			'read_project_doc',
			shape(['project', 'filename', 'offset', 'max_bytes']),
			{},
			90_000,
			64_000,
		).join(' ');
		expect(joined).toContain('page with `offset`');
		expect(joined).not.toContain('cursor');
	});

	it('does not repeat a filter the caller already supplied', () => {
		const joined = oversizeRemedies(
			'list_tasks',
			shape(['project', 'status', 'assignee_slug', 'limit', 'cursor']),
			{ status: 'in_progress', assignee_slug: 'engineer' },
			90_000,
			64_000,
		).join(' ');
		expect(joined).not.toContain('`status`');
		expect(joined).not.toContain('`assignee_slug`');
	});

	it('says so plainly when a tool exposes no narrowing parameter at all', () => {
		const remedies = oversizeRemedies('some_tool', shape([]), {}, 90_000, 64_000);
		expect(remedies).toHaveLength(1);
		expect(remedies[0]).toContain('exposes no narrowing parameter');
	});

	it('surfaces the remedies through a real overflowing tool call', async () => {
		const fatRes = await createTestProject(db, teamId, {
			name: 'Overflow Project',
			description: 'overflow',
		});
		const fatProjectId = (await fatRes.json()).data.id;
		const body = 'lorem '.repeat(1_800);
		for (let i = 0; i < 8; i++) {
			await callTool('create_task', {
				project: fatProjectId,
				title: `Fat ${i}`,
				description: body,
				assignee_id: agentId,
			});
		}
		// Opting out of the width default is what makes a page overflow now.
		const res = (await callTool('list_tasks', {
			project: fatProjectId,
			limit: 200,
			excerpt_chars: 100_000,
		})) as { error?: string; hint?: string; remedies?: string[] };
		expect(res.error).toBe('result_too_large');
		expect(res.hint).toContain('Split the work');
		expect((res.remedies ?? []).join(' ')).toContain('cursor');
	});
});

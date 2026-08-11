import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectSlug: string;
let captainToken: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Context Batch Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Ctx Project' });
	projectSlug = (await projectRes.json()).data.slug;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
		[teamId],
	);
	captainToken = (await mintAgentToken(db, masterKeyManager, captain.rows[0].id, teamId)).token;
});

afterAll(async () => {
	await safeClose(db);
});

async function callTool(
	authToken: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
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

describe('list_agents exposes the structural reporting line', () => {
	it('returns reports_to plus the resolved manager slug and title', async () => {
		const page = (await callTool(token, 'list_agents', { project: projectSlug, limit: 50 })) as {
			items: Array<Record<string, unknown>>;
		};
		const engineer = page.items.find((a) => a.slug === 'engineer');
		expect(engineer).toBeDefined();
		// Without this field an audit cannot tell an orphan from a wired agent, and
		// has to parse team_context prose - the very thing it is meant to verify.
		expect(engineer?.reports_to).toBeTruthy();
		expect(engineer?.reports_to_slug).toBe('architect');
		expect(engineer?.reports_to_title).toBe('Architect');
	});

	it('reports an orphan as a null reporting line rather than omitting the field', async () => {
		const engineer = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'engineer'`,
			[teamId],
		);
		await db.query(`UPDATE member_agents SET reports_to = NULL WHERE id = $1`, [
			engineer.rows[0].id,
		]);

		const page = (await callTool(token, 'list_agents', { project: projectSlug, limit: 50 })) as {
			items: Array<Record<string, unknown>>;
		};
		const row = page.items.find((a) => a.slug === 'engineer');
		expect(row).toBeDefined();
		expect(row?.reports_to).toBeNull();
		expect(row?.reports_to_slug).toBeNull();

		// Restore so later cases see a wired roster.
		const architect = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'architect'`,
			[teamId],
		);
		await db.query(`UPDATE member_agents SET reports_to = $1 WHERE id = $2`, [
			architect.rows[0].id,
			engineer.rows[0].id,
		]);
	});

	it('lets a caller rebuild the whole org chart from one call', async () => {
		const page = (await callTool(token, 'list_agents', { project: projectSlug, limit: 50 })) as {
			items: Array<{ slug: string; reports_to_slug: string | null }>;
			has_more: boolean;
		};
		expect(page.has_more).toBe(false);
		const chart = Object.fromEntries(page.items.map((a) => [a.slug, a.reports_to_slug]));
		expect(chart.engineer).toBe('architect');
		expect(chart['qa-engineer']).toBe('architect');
		expect(chart.architect).toBe('captain');
		expect(chart['product-lead']).toBe('captain');
	});
});

describe('get_agent_team_contexts', () => {
	it('reads the whole roster in one call instead of one per agent', async () => {
		const roster = (await callTool(token, 'list_agents', {
			project: projectSlug,
			limit: 50,
		})) as { items: Array<{ slug: string }> };
		const items = roster.items.map((a) => ({ agent_id: a.slug }));

		const page = (await callTool(token, 'get_agent_team_contexts', {
			project: projectSlug,
			items,
		})) as {
			error?: string;
			items: Array<Record<string, unknown>>;
			total: number;
			next_index: number | null;
		};
		expect(page.error).toBeUndefined();
		expect(page.total).toBe(items.length);
		expect(page.next_index).toBeNull();
		expect(page.items).toHaveLength(items.length);
		for (const row of page.items) {
			expect(row.ok).toBe(true);
			expect(typeof row.slug).toBe('string');
			expect(row).toHaveProperty('team_context');
		}
	});

	it('reports a bad agent_id per item without losing the rest', async () => {
		const page = (await callTool(token, 'get_agent_team_contexts', {
			project: projectSlug,
			items: [{ agent_id: 'engineer' }, { agent_id: 'no-such-agent' }],
		})) as { items: Array<Record<string, unknown>> };
		expect(page.items).toHaveLength(2);
		expect(page.items[0].ok).toBe(true);
		expect(page.items[1].ok).toBe(false);
		expect(String(page.items[1].error)).toMatch(/not found/i);
	});

	it('pages when the contexts exceed one chunk, covering every agent exactly once', async () => {
		// Fill each context to its 6000-char ceiling so the roster cannot fit in a
		// single chunk, then walk the cursor.
		const roster = (await callTool(token, 'list_agents', {
			project: projectSlug,
			limit: 50,
		})) as { items: Array<{ slug: string }> };
		await callTool(captainToken, 'set_agent_team_contexts', {
			project: projectSlug,
			updates: roster.items.map((a) => ({ agent_id: a.slug, content: 'C'.repeat(6000) })),
		});

		const items = roster.items.map((a) => ({ agent_id: a.slug }));
		const seen: string[] = [];
		let startIndex: number | null = 0;
		for (let i = 0; i < 30 && startIndex !== null; i++) {
			const page = (await callTool(token, 'get_agent_team_contexts', {
				project: projectSlug,
				items,
				start_index: startIndex,
			})) as {
				error?: string;
				items: Array<Record<string, unknown>>;
				next_index: number | null;
			};
			expect(page.error).toBeUndefined();
			expect(page.items.length).toBeGreaterThan(0);
			for (const row of page.items) seen.push(String(row.slug));
			startIndex = page.next_index;
		}
		expect(startIndex).toBeNull();
		expect(seen).toHaveLength(items.length);
		expect(new Set(seen).size).toBe(items.length);
	});
});

describe('batch writes for contexts and summaries', () => {
	it('set_agent_team_contexts applies every item and reports per-item results', async () => {
		const res = (await callTool(captainToken, 'set_agent_team_contexts', {
			project: projectSlug,
			updates: [
				{ agent_id: 'engineer', content: 'You report to the architect. Batch write A.' },
				{ agent_id: 'qa-engineer', content: 'You report to the architect. Batch write B.' },
			],
		})) as { items: Array<Record<string, unknown>>; updated: number; total: number };
		expect(res.updated).toBe(2);
		expect(res.total).toBe(2);
		expect(res.items.every((i) => i.ok === true)).toBe(true);

		const read = (await callTool(token, 'get_agent_team_contexts', {
			project: projectSlug,
			items: [{ agent_id: 'engineer' }, { agent_id: 'qa-engineer' }],
		})) as { items: Array<Record<string, unknown>> };
		expect(String(read.items[0].team_context)).toContain('Batch write A');
		expect(String(read.items[1].team_context)).toContain('Batch write B');
	});

	it('a bad agent_id fails only its own item', async () => {
		const res = (await callTool(captainToken, 'set_agent_team_contexts', {
			project: projectSlug,
			updates: [
				{ agent_id: 'nobody-here', content: 'orphan write' },
				{ agent_id: 'engineer', content: 'You report to the architect. Survivor.' },
			],
		})) as { items: Array<Record<string, unknown>>; updated: number };
		expect(res.updated).toBe(1);
		expect(res.items[0].ok).toBe(false);
		expect(res.items[1].ok).toBe(true);
	});

	it('set_agent_team_contexts is Captain-gated like its singular counterpart', async () => {
		const engineer = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'engineer'`,
			[teamId],
		);
		const engToken = (await mintAgentToken(db, masterKeyManager, engineer.rows[0].id, teamId))
			.token;
		const res = await callTool(engToken, 'set_agent_team_contexts', {
			project: projectSlug,
			updates: [{ agent_id: 'engineer', content: 'self-serve rewrite' }],
		});
		expect(String(res.error)).toContain('Access denied');
	});

	it('set_agent_summaries applies every item', async () => {
		const res = (await callTool(captainToken, 'set_agent_summaries', {
			project: projectSlug,
			updates: [
				{ agent_id: 'engineer', summary: 'Implements features against the approved spec.' },
				{ agent_id: 'qa-engineer', summary: 'Final approval gate for every task.' },
			],
		})) as { items: Array<Record<string, unknown>>; updated: number };
		expect(res.updated).toBe(2);

		const rows = await db.query<{ slug: string; summary: string }>(
			`SELECT ma.slug, ma.summary FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug IN ('engineer', 'qa-engineer') ORDER BY ma.slug`,
			[teamId],
		);
		// Ordered by slug: engineer before qa-engineer.
		expect(rows.rows[0].summary).toContain('Implements features');
		expect(rows.rows[1].summary).toContain('Final approval gate');
	});

	it('files one coherence review for the batch, not one per agent', async () => {
		const before = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM tasks
			 WHERE project_id = (SELECT id FROM projects WHERE slug = $1)
			   AND labels @> '["team-coherence-review"]'::jsonb`,
			[projectSlug],
		);
		await callTool(captainToken, 'set_agent_summaries', {
			project: projectSlug,
			updates: [
				{ agent_id: 'engineer', summary: 'Rev two of the engineer summary.' },
				{ agent_id: 'qa-engineer', summary: 'Rev two of the QA summary.' },
				{ agent_id: 'architect', summary: 'Rev two of the architect summary.' },
			],
		});
		const after = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM tasks
			 WHERE project_id = (SELECT id FROM projects WHERE slug = $1)
			   AND labels @> '["team-coherence-review"]'::jsonb`,
			[projectSlug],
		);
		// Three summaries updated; reviews coalesce, so this must not add three.
		expect(after.rows[0].c - before.rows[0].c).toBeLessThanOrEqual(1);
	});
});

import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { detectNarratedActiveMentions, detectQuotedMentionTokens } from '../src/lib/mentions';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

// The screenshot case: an agent explains it is blocked because an EARLIER comment
// carries an unanswered `@admin` ask — and writes that explanation with live
// `@admin` tokens ("the @admin mention in INV-7#comment-…"). Those don't point at
// the other comment; they fire fresh mentions here, which for @admin means a new
// unanswered admin ask — the very condition holding the ticket open. The fix is
// backticks (quoting the token), not the passive form (which drops the `@` and
// loses the token being quoted), and the server warns rather than rewriting.

describe('detectNarratedActiveMentions', () => {
	const slugs = ['architect', 'qa-engineer', 'admin'];

	it('flags the screenshot case: `the @admin mention in <task>#comment-<id>`', () => {
		expect(
			detectNarratedActiveMentions(
				'The document passed two verification rounds since the original report that ' +
					'contained the @admin mention in INV-7#comment-20260722122856.',
				slugs,
			),
		).toEqual(['admin']);
	});

	it('flags a narrated mention introduced by an article ("contains an @admin mention")', () => {
		expect(
			detectNarratedActiveMentions(
				"The server won't let me mark this done because the original report contains an " +
					'@admin mention with no human reply.',
				slugs,
			),
		).toEqual(['admin']);
	});

	it('flags a narrated teammate ping', () => {
		expect(
			detectNarratedActiveMentions('I already answered the @architect ping in IN-4.', slugs),
		).toEqual(['architect']);
	});

	it('flags the noun-first order ("a mention of @admin")', () => {
		expect(
			detectNarratedActiveMentions('That was a mention of @admin from last week.', slugs),
		).toEqual(['admin']);
	});

	it('does not flag a genuine ask — the live mention is the point there', () => {
		expect(detectNarratedActiveMentions('@admin — please approve the draft.', slugs)).toEqual([]);
		expect(
			detectNarratedActiveMentions('@architect — please review this before we ship.', slugs),
		).toEqual([]);
	});

	it('does not flag an imperative ask that uses a narration noun as a VERB', () => {
		// "@admin ping me …" is a genuine wake; only a determiner-anchored token
		// ("the @admin ping") is narration. A determiner elsewhere in the sentence
		// must not reach across and anchor it either.
		expect(detectNarratedActiveMentions('@admin ping me when you are back.', slugs)).toEqual([]);
		expect(detectNarratedActiveMentions('Check the doc? @admin ping me when done.', slugs)).toEqual(
			[],
		);
	});

	it('flags a narrated token carrying adjectives between determiner and mention', () => {
		expect(
			detectNarratedActiveMentions('the original unanswered @admin mention is still open.', slugs),
		).toEqual(['admin']);
	});

	it('does not flag the quoted (backticked) form the warning asks for', () => {
		expect(
			detectNarratedActiveMentions('the `@admin` mention in INV-7 is still unanswered.', slugs),
		).toEqual([]);
	});

	it('does not flag the passive form — it fires nothing, so there is nothing to warn about', () => {
		expect(detectNarratedActiveMentions('the @@admin mention in INV-7 is stale.', slugs)).toEqual(
			[],
		);
		expect(detectNarratedActiveMentions('a mention of @@admin from last week.', slugs)).toEqual([]);
	});

	it('does not flag narration about the PERSON speaking (whose fix is the passive form)', () => {
		// "@admin mentioned that …" reports what the admin said — it is not the mention
		// token being quoted, so `mentioned`/`pinged` are deliberately excluded.
		expect(detectNarratedActiveMentions('@admin mentioned that we should ship.', slugs)).toEqual(
			[],
		);
	});

	it('does not flag a slug that only appears inside a longer hyphenated slug', () => {
		expect(
			detectNarratedActiveMentions('the @qa-engineer mention in IN-9', ['engineer', 'qa-engineer']),
		).toEqual(['qa-engineer']);
	});

	it('ignores narrated mentions inside inline code and fenced blocks', () => {
		expect(detectNarratedActiveMentions('`the @admin mention in INV-7`', slugs)).toEqual([]);
		expect(detectNarratedActiveMentions('```\nthe @admin mention in INV-7\n```', slugs)).toEqual(
			[],
		);
	});

	it('returns [] for empty content', () => {
		expect(detectNarratedActiveMentions('', slugs)).toEqual([]);
		expect(detectNarratedActiveMentions(null, slugs)).toEqual([]);
	});
});

describe('detectQuotedMentionTokens (backtick-warning carve-out)', () => {
	const slugs = ['architect', 'admin'];

	it('recognises a backticked mention token in narrated position', () => {
		expect(detectQuotedMentionTokens('I answered the `@architect` ping in IN-4.', slugs)).toEqual([
			'architect',
		]);
	});

	it('does not claim a backticked mention that is not narrated (a plain backtick mistake)', () => {
		// `@architect` here is an ordinary reference the author wrongly backticked —
		// the backtick warning must still fire on it.
		expect(detectQuotedMentionTokens('Ask `@architect` if you get blocked.', slugs)).toEqual([]);
	});
});

describe('MCP create_comment / update_comment warn on narrated active mentions', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let masterKeyManager: MasterKeyManager;

	let teamId: string;
	let projectId: string;
	let architectId: string;
	let productLeadId: string;

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

	async function callTool(
		agentToken: string,
		name: string,
		args: Record<string, unknown>,
	): Promise<{ id?: string; warning?: string; error?: string }> {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name, arguments: args },
				id: 1,
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		return JSON.parse(body.result.content[0].text) as {
			id?: string;
			warning?: string;
			error?: string;
		};
	}

	async function agentTokenFor(memberId: string, taskId: string): Promise<string> {
		const { token: t } = await mintAgentToken(db, masterKeyManager, memberId, teamId, taskId, {
			projectId,
		});
		return t;
	}

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

		const teamRes = await createTestTeam(db, { name: 'Narrated Co', template_id: typeId });
		teamId = (await teamRes.json()).data.id;

		const projectData = (await (await createTestProject(db, teamId, { name: 'Narrated' })).json())
			.data;
		projectId = projectData.id;

		const agentsRes = await app.request(`/api/projects/${projectData.slug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
		architectId = agents.find((a) => a.slug === 'architect')!.id;
		productLeadId = agents.find((a) => a.slug === 'product-lead')!.id;
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('warns on a narrated @admin mention and offers the backticked fix', async () => {
		const taskId = await insertTask(architectId, 'Narrated admin mention');
		const result = await callTool(await agentTokenFor(productLeadId, taskId), 'create_comment', {
			project: projectId,
			task_id: taskId,
			content:
				'@admin — this is ready to close. The blocker is that the earlier report contains ' +
				'an @admin mention with no human reply.',
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeDefined();
		expect(result.warning).toContain('@admin');
		expect(result.warning).toContain('backticks');
		// The self-defeating consequence is called out explicitly for @admin.
		expect(result.warning).toContain('blocks this task from going done');
	});

	it('does not warn when the narrated token is backticked, and the real ask still notifies', async () => {
		const taskId = await insertTask(architectId, 'Quoted admin mention');
		const result = await callTool(await agentTokenFor(productLeadId, taskId), 'create_comment', {
			project: projectId,
			task_id: taskId,
			content:
				'@admin — this is ready to close. The blocker is that the earlier report contains ' +
				'an `@admin` mention with no human reply.',
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeUndefined();
		// The leading ask is untouched: it still lands in the admin inbox.
		const r = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM admin_mentions WHERE comment_id = $1`,
			[result.id],
		);
		expect(r.rows[0].c).toBeGreaterThan(0);
	});

	it('does not tell the author to un-backtick a quoted teammate token (no contradicting warnings)', async () => {
		// The backticked-entity check would normally flag `@architect` as a Hezo
		// reference wrongly wrapped in code — but here the backticks are the fix the
		// narrated-mention rule asks for, so neither warning may fire.
		const taskId = await insertTask(productLeadId, 'Quoted teammate token');
		const result = await callTool(await agentTokenFor(productLeadId, taskId), 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: 'Already handled — I answered the `@architect` ping in the earlier thread.',
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});

	it('still warns on an ordinary backticked teammate reference (carve-out is narrow)', async () => {
		const taskId = await insertTask(productLeadId, 'Plain backticked teammate');
		const result = await callTool(await agentTokenFor(productLeadId, taskId), 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: 'Ask `@architect` if you get blocked on the schema.',
		});
		expect(result.warning).toBeDefined();
		expect(result.warning).toContain('backticks');
	});

	it('warns when an edit introduces a narrated active mention', async () => {
		const taskId = await insertTask(architectId, 'Edit into narrated mention');
		const agentToken = await agentTokenFor(productLeadId, taskId);
		const created = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: 'Draft ready.',
		});
		expect(created.warning).toBeUndefined();

		const edited = await callTool(agentToken, 'update_comment', {
			project: projectId,
			task_id: taskId,
			comment_id: created.id,
			content: 'Blocked on the @admin mention in the earlier verification report.',
		});
		expect(edited.warning).toBeDefined();
		expect(edited.warning).toContain('backticks');
	});
});

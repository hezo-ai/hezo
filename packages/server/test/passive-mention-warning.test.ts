import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { detectPassiveTeammateAsks } from '../src/lib/mentions';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

// The screenshot case: an agent ends a comment with `@@admin — …` (the passive
// mention form). It renders as a bare-word link, so it LOOKS like a ping, but @@
// notifies no one — the handoff stalls. We warn only when the text next to the
// passive mention reads like an ask (an active @admin was intended), never on a
// deliberate passive reference.

describe('detectPassiveTeammateAsks', () => {
	const slugs = ['architect', 'qa-engineer', 'engineer', 'admin'];

	it('flags the screenshot case: passive @@admin address with a second-person ask', () => {
		expect(
			detectPassiveTeammateAsks(
				"@@admin — the drafts are ready for your re-review in Typefully when you're set.",
				slugs,
			),
		).toEqual(['admin']);
	});

	it('flags an emphasised passive address with an imperative opener', () => {
		expect(detectPassiveTeammateAsks('**@@architect** — please review.', slugs)).toEqual([
			'architect',
		]);
	});

	it('flags a leading-line passive address that asks a question', () => {
		expect(detectPassiveTeammateAsks('@@admin: can you approve?', slugs)).toEqual(['admin']);
	});

	it('flags the routing-label screenshot case: `**Next step:** @@captain — …your…`', () => {
		// The exact stalled handoff: a passive @@captain sits after a `**Next step:**`
		// label (not the first token on the line) with a second-person ask, while the
		// only actively-mentioned name is @admin — so the captain was never woken.
		expect(
			detectPassiveTeammateAsks(
				'**Next step:** @@captain — this X thread draft is reviewed and approved from my ' +
					'side. Ready for your strategic review. After Captain sign-off, @admin will need to ' +
					'attach screen recordings in Typefully before final approval and scheduling.',
				['captain', 'admin', 'marketing-lead'],
			),
		).toEqual(['captain']);
	});

	it('flags a routing-label passive address without markdown emphasis', () => {
		expect(detectPassiveTeammateAsks('Next step: @@architect — can you review?', slugs)).toEqual([
			'architect',
		]);
	});

	it('does not flag a routing-label passive handoff with no ask intent', () => {
		expect(
			detectPassiveTeammateAsks('**Next step:** @@architect — merged and shipped.', slugs),
		).toEqual([]);
	});

	it('does not flag a teammate named after an unrelated label phrase', () => {
		// The colon belongs to an unrelated lead-in; `architect` is mid-sentence, not
		// addressed — the bounded, same-line label must sit immediately before the name.
		expect(
			detectPassiveTeammateAsks('Status update: the @@architect plan is ready, thanks.', slugs),
		).toEqual([]);
	});

	it('flags the verdict-report case: "Required actions for @@slug" heading over an imperative list', () => {
		// The DGXX verification report shape: a heading assigns required actions to a
		// passive @@ mention, and the numbered list below is pure imperatives — no
		// second-person pronoun, no `please`, no `?` — so the paragraph ask-gate
		// never fires. The action-assignment phrase on the heading line IS the ask.
		expect(
			detectPassiveTeammateAsks(
				'## Required actions for @@engineer\n\n' +
					'1. Reconcile the Phase 1 timing with the 8-K.\n' +
					'2. Bridge run-rate to recognized revenue.\n' +
					'3. Fix the source duplication.\n\n' +
					'Return to me for re-verification when these are addressed.',
				slugs,
			),
		).toEqual(['engineer']);
	});

	it('flags a bold action-assignment label line with a passive mention', () => {
		expect(
			detectPassiveTeammateAsks(
				'**Action items for @@architect**\n\n- Update the spec.\n- Re-run the checks.',
				slugs,
			),
		).toEqual(['architect']);
	});

	it('flags a colon-terminated action-assignment line with a passive mention', () => {
		expect(
			detectPassiveTeammateAsks('Next steps for @@qa-engineer:\n\n- Re-test the flow.', slugs),
		).toEqual(['qa-engineer']);
	});

	it('does not flag a heading naming a passive mention without an action-assignment phrase', () => {
		expect(
			detectPassiveTeammateAsks('## Notes from @@architect\n\n- The design held up well.', slugs),
		).toEqual([]);
	});

	it('does not flag an attribution heading ("Actions taken by") — compound phrases only', () => {
		expect(
			detectPassiveTeammateAsks('## Actions taken by @@architect\n\n- Migrated the schema.', slugs),
		).toEqual([]);
	});

	it('does not flag an action-assignment heading when the slug is also actively mentioned', () => {
		expect(
			detectPassiveTeammateAsks(
				'## Required actions for @@engineer\n\n1. Fix the build.\n\n@engineer — please pick these up.',
				slugs,
			),
		).toEqual([]);
	});

	it('does not flag a slug that only appears inside a longer hyphenated slug', () => {
		// `engineer` must not match inside `@@qa-engineer` — only the addressed
		// teammate is flagged, even when the roster carries overlapping slugs.
		expect(
			detectPassiveTeammateAsks('## Required actions for @@qa-engineer\n\n1. Re-test.', slugs),
		).toEqual(['qa-engineer']);
	});

	it('does not flag an action-assignment phrase in plain prose (not a heading/label line)', () => {
		expect(
			detectPassiveTeammateAsks(
				'I folded the required actions from @@architect into the tracker already.',
				slugs,
			),
		).toEqual([]);
	});

	it('does not flag a passive FYI with no ask intent', () => {
		expect(detectPassiveTeammateAsks('@@admin — release is done.', slugs)).toEqual([]);
	});

	it('does not flag a mid-prose passive reference', () => {
		expect(detectPassiveTeammateAsks('as @@admin noted, ship it when you can.', slugs)).toEqual([]);
	});

	it('does not flag a slug that is also actively mentioned', () => {
		expect(detectPassiveTeammateAsks('@admin — done. cc @@admin, your call.', slugs)).toEqual([]);
	});

	it('does not flag an active-only mention', () => {
		expect(detectPassiveTeammateAsks('@architect — please review.', slugs)).toEqual([]);
	});

	it('does not flag a passive address to a non-teammate', () => {
		expect(detectPassiveTeammateAsks('@@database — check your config', slugs)).toEqual([]);
	});

	it('ignores passive asks inside inline code and fenced blocks', () => {
		expect(detectPassiveTeammateAsks('inert: `@@admin — please review` here', slugs)).toEqual([]);
		expect(detectPassiveTeammateAsks('```\n@@admin — can you approve?\n```', slugs)).toEqual([]);
	});

	it('scopes the ask signal to the paragraph carrying the passive mention', () => {
		// The "you" lives in a different paragraph than @@admin, so no ask is inferred.
		expect(
			detectPassiveTeammateAsks('@@admin — release is done.\n\nthanks, you all rock', slugs),
		).toEqual([]);
	});
});

describe('MCP create_comment / update_comment warn on passive-mention asks', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let masterKeyManager: MasterKeyManager;

	let teamId: string;
	let projectId: string;
	let architectId: string;
	let architectSlug: string;
	let productLeadId: string;
	let captainId: string;

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

	async function adminMentionCount(commentId: string): Promise<number> {
		const r = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM admin_mentions WHERE comment_id = $1`,
			[commentId],
		);
		return r.rows[0].c;
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

		const teamRes = await createTestTeam(db, { name: 'Passive Co', template_id: typeId });
		teamId = (await teamRes.json()).data.id;

		const projectData = (await (await createTestProject(db, teamId, { name: 'Project' })).json())
			.data;
		projectId = projectData.id;

		const agentsRes = await app.request(`/api/projects/${projectData.slug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
		const architect = agents.find((a) => a.slug === 'architect')!;
		architectId = architect.id;
		architectSlug = architect.slug;
		productLeadId = agents.find((a) => a.slug === 'product-lead')!.id;
		captainId = agents.find((a) => a.slug === 'captain')!.id;
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('warns on a passive @@admin ask and notifies no one', async () => {
		const taskId = await insertTask(architectId, 'Passive admin ask');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
			{ projectId },
		);
		const result = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: "@@admin — the drafts are ready for your re-review when you're set.",
		});
		expect(result.warning).toBeDefined();
		expect(result.warning).toContain('admin');
		expect(result.warning).toContain('active mention');
		// The passive form genuinely notified no one.
		expect(await adminMentionCount(result.id!)).toBe(0);
	});

	it('warns on the routing-label handoff `**Next step:** @@captain — …your…` (screenshot case)', async () => {
		const taskId = await insertTask(captainId, 'Routing-label captain handoff');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
			{ projectId },
		);
		const result = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content:
				'**Next step:** @@captain — this draft is reviewed and approved from my side. Ready ' +
				'for your strategic review before we schedule.',
		});
		expect(result.warning).toBeDefined();
		expect(result.warning).toContain('captain');
		expect(result.warning).toContain('active mention');
	});

	it('does not warn on a passive @@admin reference with no ask intent', async () => {
		const taskId = await insertTask(architectId, 'Passive admin FYI');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
			{ projectId },
		);
		const result = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: '@@admin — release is done.',
		});
		expect(result.warning).toBeUndefined();
		expect(await adminMentionCount(result.id!)).toBe(0);
	});

	it('does not warn on an active @admin ask and does notify', async () => {
		const taskId = await insertTask(architectId, 'Active admin ask');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
			{ projectId },
		);
		const result = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: '@admin — the drafts are ready for your re-review.',
		});
		expect(result.warning).toBeUndefined();
		expect(await adminMentionCount(result.id!)).toBeGreaterThan(0);
	});

	it('does not warn when an agent passively addresses itself', async () => {
		const taskId = await insertTask(architectId, 'Self passive ask');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
			{ projectId },
		);
		const result = await callTool(agentToken, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: `@@${architectSlug} — remember to review your own plan.`,
		});
		expect(result.warning).toBeUndefined();
	});

	it('warns when an edit turns a comment into a passive @@admin ask', async () => {
		const taskId = await insertTask(architectId, 'Edit into passive ask');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			productLeadId,
			teamId,
			taskId,
			{ projectId },
		);
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
			content: '@@admin — please take a look when you can.',
		});
		expect(edited.warning).toBeDefined();
		expect(edited.warning).toContain('admin');
		expect(await adminMentionCount(created.id!)).toBe(0);
	});
});

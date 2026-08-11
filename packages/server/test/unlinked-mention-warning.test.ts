import { WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { detectUnlinkedTeammateReferences } from '../src/lib/mentions';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

describe('detectUnlinkedTeammateReferences', () => {
	const slugs = ['architect', 'qa-engineer', 'engineer', 'admin'];

	it('flags a teammate addressed by bold name (the stalled-handoff case)', () => {
		expect(
			detectUnlinkedTeammateReferences('**architect** — my plan review is complete.', slugs),
		).toEqual(['architect']);
	});

	it('flags a teammate addressed by a leading bare name', () => {
		expect(detectUnlinkedTeammateReferences('architect: please review this.', slugs)).toEqual([
			'architect',
		]);
	});

	it('flags a teammate addressed after a routing label (`**Next step:** architect —`)', () => {
		expect(
			detectUnlinkedTeammateReferences('**Next step:** architect — review complete.', slugs),
		).toEqual(['architect']);
	});

	it('does not flag a teammate named after an unrelated label phrase', () => {
		expect(
			detectUnlinkedTeammateReferences('Status update: the architect finished the plan.', slugs),
		).toEqual([]);
	});

	it('does not flag an active @mention', () => {
		expect(detectUnlinkedTeammateReferences('@architect — please consolidate.', slugs)).toEqual([]);
	});

	it('does not flag a passive @@mention', () => {
		expect(detectUnlinkedTeammateReferences('@@architect handled the review.', slugs)).toEqual([]);
	});

	it('does not flag an ordinary mid-prose reference', () => {
		expect(
			detectUnlinkedTeammateReferences('I think the architect decided to refactor.', slugs),
		).toEqual([]);
	});

	it('ignores names inside inline code and fenced blocks', () => {
		expect(detectUnlinkedTeammateReferences('inert: `**architect**` here', slugs)).toEqual([]);
		expect(detectUnlinkedTeammateReferences('```\n**architect** — go\n```', slugs)).toEqual([]);
	});

	it('does not flag a bold word that is not a teammate slug', () => {
		expect(detectUnlinkedTeammateReferences('**database** — migrate it', slugs)).toEqual([]);
	});

	it('flags @admin addressed by bold name', () => {
		expect(detectUnlinkedTeammateReferences('**admin** — please approve.', slugs)).toEqual([
			'admin',
		]);
	});
});

describe('MCP create_comment warns on unlinked teammate references', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let masterKeyManager: MasterKeyManager;

	let teamId: string;
	let projectId: string;
	let architectId: string;
	let captainId: string;
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

	async function postComment(
		authorAgentId: string,
		taskId: string,
		content: string,
	): Promise<{ id: string; warning?: string }> {
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			authorAgentId,
			teamId,
			taskId,
		);
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'create_comment',
					arguments: { project: projectId, task_id: taskId, content },
				},
				id: 1,
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		return JSON.parse(body.result.content[0].text) as { id: string; warning?: string };
	}

	async function mentionWakeupExists(commentId: string, memberId: string): Promise<boolean> {
		const res = await db.query(
			`SELECT 1 FROM agent_wakeup_requests
			 WHERE payload->>'comment_id' = $1 AND member_id = $2 AND source = $3::wakeup_source`,
			[commentId, memberId, WakeupSource.Mention],
		);
		return res.rows.length > 0;
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

		const teamRes = await createTestTeam(db, { name: 'Warn Co', template_id: typeId });
		teamId = (await teamRes.json()).data.id;

		const setupSlug = (await (await createTestProject(db, teamId, { name: 'Setup' })).json()).data
			.slug;
		const agentsRes = await app.request(`/api/projects/${setupSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
		captainId = agents.find((a) => a.slug === 'captain')!.id;
		architectId = agents.find((a) => a.slug === 'architect')!.id;
		productLeadId = agents.find((a) => a.slug === 'product-lead')!.id;

		const projectData = (await (await createTestProject(db, teamId, { name: 'Project' })).json())
			.data;
		projectId = projectData.id;
	});

	afterAll(async () => {
		await safeClose(db);
	});

	beforeEach(async () => {
		await db.query('DELETE FROM agent_wakeup_requests');
	});

	it('warns and wakes no one when a teammate is addressed in bold', async () => {
		const taskId = await insertTask(captainId, 'Bold handoff');
		const result = await postComment(productLeadId, taskId, '**architect** — review done');
		expect(result.warning).toBeDefined();
		expect(result.warning).toContain('architect');
		expect(await mentionWakeupExists(result.id, architectId)).toBe(false);
	});

	it('does not warn and wakes the teammate on a real @mention', async () => {
		const taskId = await insertTask(captainId, 'Active handoff');
		const result = await postComment(productLeadId, taskId, '@architect — review done');
		expect(result.warning).toBeUndefined();
		expect(await mentionWakeupExists(result.id, architectId)).toBe(true);
	});

	it('does not warn on a self-reference in bold', async () => {
		const taskId = await insertTask(architectId, 'Architect own task');
		const result = await postComment(architectId, taskId, '**architect** notes to self');
		expect(result.warning).toBeUndefined();
	});
});

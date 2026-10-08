import { SUMMARY_DETAILS_HEADING } from '@hezo/shared';
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
import { callMcpTool } from './helpers/mcp-call';

const LONG = 'The evidence ledger covers every source. '.repeat(30);
const WELL_FORMED = `Review passed. Nothing for people to do.\n\n${SUMMARY_DETAILS_HEADING}\n\n${LONG}`;

describe('MCP write tools warn on the summary and technical details shape', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let masterKeyManager: MasterKeyManager;
	let teamId: string;
	let projectId: string;
	let captainId: string;
	let architectId: string;

	async function insertTask(assigneeId: string, title: string): Promise<string> {
		const meta = await db.query<{ task_prefix: string; number: number }>(
			`SELECT p.task_prefix, next_project_task_number(p.id) AS number
			 FROM projects p WHERE p.id = $1`,
			[projectId],
		);
		const n = meta.rows[0].number;
		const res = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, $3, $4, $5, $6, 'in_progress'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id`,
			[teamId, projectId, assigneeId, n, `${meta.rows[0].task_prefix}-${n}`, title],
		);
		return res.rows[0].id;
	}

	async function agentToken(agentId: string, taskId: string | null): Promise<string> {
		return (await mintAgentToken(db, masterKeyManager, agentId, teamId, taskId, { projectId }))
			.token;
	}

	async function call(
		bearer: string,
		name: string,
		args: Record<string, unknown>,
	): Promise<{
		id?: string;
		error?: string;
		warning?: string;
		tasks?: Array<{ warning?: string }>;
	}> {
		return await callMcpTool(app, bearer, name, args);
	}

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;
		masterKeyManager = ctx.masterKeyManager;

		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const typeId = (await typesRes.json()).data.find(
			(t: { name: string }) => t.name === 'App Team',
		).id;
		const teamRes = await createTestTeam(db, { name: 'Summary Shape Co', template_id: typeId });
		teamId = (await teamRes.json()).data.id;
		const project = (await (await createTestProject(db, teamId, { name: 'Summary Shape' })).json())
			.data;
		projectId = project.id;

		const agents = (
			await (
				await app.request(`/api/projects/${project.slug}/agents`, { headers: authHeader(token) })
			).json()
		).data as Array<{ id: string; slug: string }>;
		captainId = agents.find((a) => a.slug === 'captain')!.id;
		architectId = agents.find((a) => a.slug === 'architect')!.id;
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('warns on create_comment when long text has no technical details, and still saves it', async () => {
		const taskId = await insertTask(architectId, 'Long comment');
		const result = await call(await agentToken(architectId, taskId), 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: LONG,
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toContain('has no technical details section');
		const saved = await db.query<{ c: number }>(
			'SELECT COUNT(*)::int AS c FROM task_comments WHERE task_id = $1',
			[taskId],
		);
		expect(saved.rows[0].c).toBe(1);
	});

	it('does not warn on a well-formed comment or a short plain one', async () => {
		const taskId = await insertTask(architectId, 'Well formed');
		const bearer = await agentToken(architectId, taskId);
		for (const content of [WELL_FORMED, 'Reconnected. The daily check runs again.']) {
			const result = await call(bearer, 'create_comment', {
				project: projectId,
				task_id: taskId,
				content,
			});
			expect(result.error).toBeUndefined();
			expect(result.warning).toBeUndefined();
		}
	});

	it('warns when an active mention sits only under the marker', async () => {
		const taskId = await insertTask(architectId, 'Hidden ask');
		const result = await call(await agentToken(architectId, taskId), 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: `Review done.\n\n${SUMMARY_DETAILS_HEADING}\n\n@captain please merge it.`,
		});
		expect(result.warning).toContain('@captain is mentioned only under');
	});

	it('warns on update_comment for a near-miss marker and clears once the edit fixes it', async () => {
		const taskId = await insertTask(architectId, 'Edited shape');
		const bearer = await agentToken(architectId, taskId);
		const created = await call(bearer, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: 'Draft.',
		});
		const nearMiss = await call(bearer, 'update_comment', {
			project: projectId,
			task_id: taskId,
			comment_id: created.id,
			content: `Review passed.\n\n## Details\n\n${LONG}`,
		});
		expect(nearMiss.warning).toContain('"## Details" is not the technical-details marker');
		const fixed = await call(bearer, 'update_comment', {
			project: projectId,
			task_id: taskId,
			comment_id: created.id,
			content: WELL_FORMED,
		});
		expect(fixed.warning).toBeUndefined();
	});

	it('warns on create_task, create_tasks and update_task descriptions', async () => {
		const parentId = await insertTask(captainId, 'Parent');
		const bearer = await agentToken(captainId, parentId);
		const created = await call(bearer, 'create_task', {
			project: projectId,
			title: 'Long brief',
			description: LONG,
			assignee_id: architectId,
		});
		expect(created.error).toBeUndefined();
		expect(created.warning).toContain('has no technical details section');

		const batch = await call(bearer, 'create_tasks', {
			project: projectId,
			items: [
				{
					title: 'Empty summary',
					assignee_id: architectId,
					description: `${SUMMARY_DETAILS_HEADING}\n\nSteps.`,
				},
			],
		});
		expect(JSON.stringify(batch)).toContain('people see nothing until they expand it');

		const updated = await call(bearer, 'update_task', {
			project: projectId,
			task_id: created.id,
			description: WELL_FORMED,
		});
		expect(updated.error).toBeUndefined();
		expect(updated.warning).toBeUndefined();
	});

	it('checks only the description on update_task, not the progress summary', async () => {
		const taskId = await insertTask(architectId, 'Progress only');
		const result = await call(await agentToken(architectId, taskId), 'update_task', {
			project: projectId,
			task_id: taskId,
			progress_summary: LONG,
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});

	it('never warns a person', async () => {
		const taskId = await insertTask(architectId, 'Human writes');
		const result = await call(token, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: LONG,
		});
		expect(result.error).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});
});

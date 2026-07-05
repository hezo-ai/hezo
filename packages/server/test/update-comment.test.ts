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

/**
 * update_comment lets an agent edit a text comment its CURRENT run authored — a
 * clean fix for a typo/broken reference/bad markdown instead of a duplicate
 * repost. Edits re-run create-time side effects idempotently: a mention the edit
 * adds (e.g. un-backticking an inert @slug) wakes that teammate exactly once.
 */
describe('update_comment MCP tool', () => {
	let app: Hono<Env>;
	let db: Db;
	let superToken: string;
	let masterKeyManager: MasterKeyManager;

	let teamId: string;
	let projectId: string;
	let architectId: string;
	let otherId: string;
	let otherSlug: string;
	let taskId: string;

	async function callTool(
		agentToken: string,
		name: string,
		args: Record<string, unknown>,
	): Promise<{ id?: string; error?: string; warning?: string }> {
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
		return JSON.parse(body.result.content[0].text);
	}

	async function commentText(commentId: string): Promise<string | null> {
		const r = await db.query<{ t: string | null }>(
			`SELECT content->>'text' AS t FROM task_comments WHERE id = $1`,
			[commentId],
		);
		return r.rows[0]?.t ?? null;
	}

	async function mentionWakeupCount(memberId: string, commentId: string): Promise<number> {
		const r = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM agent_wakeup_requests
			 WHERE member_id = $1 AND source = 'mention'::wakeup_source
			   AND payload->>'comment_id' = $2`,
			[memberId, commentId],
		);
		return r.rows[0].c;
	}

	async function insertTask(assigneeId: string): Promise<string> {
		const meta = await db.query<{ task_prefix: string; number: number }>(
			`SELECT p.task_prefix, next_project_task_number(p.id) AS number
			 FROM projects p WHERE p.id = $1`,
			[projectId],
		);
		const identifier = `${meta.rows[0].task_prefix}-${meta.rows[0].number}`;
		const res = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, $3, $4, $5, 'A task', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id`,
			[teamId, projectId, assigneeId, meta.rows[0].number, identifier],
		);
		return res.rows[0].id;
	}

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		superToken = ctx.token;
		masterKeyManager = ctx.masterKeyManager;

		const typesRes = await app.request('/api/team-templates', { headers: authHeader(superToken) });
		const typeId = (await typesRes.json()).data.find(
			(t: Record<string, unknown>) => t.name === 'Startup',
		).id;

		const teamRes = await createTestTeam(db, { name: 'Edit Co', template_id: typeId });
		teamId = (await teamRes.json()).data.id;

		const projectData = (await (await createTestProject(db, teamId, { name: 'Edit' })).json()).data;
		projectId = projectData.id;

		const agentsRes = await app.request(`/api/projects/${projectData.slug}/agents`, {
			headers: authHeader(superToken),
		});
		const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
		architectId = agents.find((a) => a.slug === 'architect')!.id;
		const other = agents.find((a) => a.slug !== 'architect')!;
		otherId = other.id;
		otherSlug = other.slug;

		taskId = await insertTask(architectId);
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('edits a text comment the current run authored', async () => {
		const { token } = await mintAgentToken(db, masterKeyManager, architectId, teamId, taskId, {
			projectId,
		});
		const created = await callTool(token, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: 'Frist draft',
		});
		expect(created.id).toBeDefined();

		const edited = await callTool(token, 'update_comment', {
			project: projectId,
			task_id: taskId,
			comment_id: created.id,
			content: 'First draft (fixed)',
		});
		expect(edited.error).toBeUndefined();
		expect(edited.id).toBe(created.id);
		expect(await commentText(created.id!)).toBe('First draft (fixed)');
	});

	it('wakes a teammate the edit newly mentions, and stays idempotent on re-edit', async () => {
		const { token } = await mintAgentToken(db, masterKeyManager, architectId, teamId, taskId, {
			projectId,
		});
		// Backticked mention is inert — no wakeup fires on create.
		const created = await callTool(token, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: `ping \`@${otherSlug}\``,
		});
		expect(created.id).toBeDefined();
		expect(await mentionWakeupCount(otherId, created.id!)).toBe(0);

		// Editing to a bare mention wakes the teammate for the first time.
		await callTool(token, 'update_comment', {
			project: projectId,
			task_id: taskId,
			comment_id: created.id,
			content: `ping @${otherSlug}`,
		});
		expect(await mentionWakeupCount(otherId, created.id!)).toBe(1);

		// Re-editing with the same mention does not create a second wakeup.
		await callTool(token, 'update_comment', {
			project: projectId,
			task_id: taskId,
			comment_id: created.id,
			content: `ping @${otherSlug} once more`,
		});
		expect(await mentionWakeupCount(otherId, created.id!)).toBe(1);
	});

	it('refuses to edit a comment authored by a different run', async () => {
		const { token: t1 } = await mintAgentToken(db, masterKeyManager, architectId, teamId, taskId, {
			projectId,
		});
		const created = await callTool(t1, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: 'run one',
		});
		const { token: t2 } = await mintAgentToken(db, masterKeyManager, architectId, teamId, taskId, {
			projectId,
		});
		const res = await callTool(t2, 'update_comment', {
			project: projectId,
			task_id: taskId,
			comment_id: created.id,
			content: 'hijack',
		});
		expect(res.error).toContain('during this run');
		expect(await commentText(created.id!)).toBe('run one');
	});

	it("refuses to edit another agent's comment", async () => {
		const { token: tOther } = await mintAgentToken(db, masterKeyManager, otherId, teamId, taskId, {
			projectId,
		});
		const created = await callTool(tOther, 'create_comment', {
			project: projectId,
			task_id: taskId,
			content: 'not yours',
		});
		const { token: tArch } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
			{
				projectId,
			},
		);
		const res = await callTool(tArch, 'update_comment', {
			project: projectId,
			task_id: taskId,
			comment_id: created.id,
			content: 'steal',
		});
		expect(res.error).toContain('during this run');
		expect(await commentText(created.id!)).toBe('not yours');
	});

	it('refuses to edit a non-text comment', async () => {
		const { token, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
			{ projectId },
		);
		const sys = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_by_run_id)
			 VALUES ($1, $2, 'system'::comment_content_type, $3::jsonb, $4) RETURNING id`,
			[taskId, architectId, JSON.stringify({ kind: 'note' }), runId],
		);
		const res = await callTool(token, 'update_comment', {
			project: projectId,
			task_id: taskId,
			comment_id: sys.rows[0].id,
			content: 'text now',
		});
		expect(res.error).toContain('Only text comments');
	});
});

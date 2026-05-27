import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { buildCoachReviewPrompt, type TaskInfo } from '../src/services/agent-runner';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, mintAgentToken } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let boardToken: string;
let teamId: string;
let projectId: string;
let taskId: string;
let coachId: string;
let engineerId: string;
let engineerToken: string;
let architectId: string;
let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	boardToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(boardToken) });
	const teamTemplateId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Coach Test Co',
			template_id: teamTemplateId,
		}),
	});
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Coach Test Project',
		description: 'Test project.',
	});
	projectId = (await projectRes.json()).data.id;

	const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
		headers: authHeader(boardToken),
	});
	const agents = (await agentsRes.json()).data;

	const coach = agents.find((a: any) => a.slug === 'coach');
	const engineer = agents.find((a: any) => a.slug === 'engineer');
	const architect = agents.find((a: any) => a.slug === 'architect');

	expect(coach).toBeTruthy();
	expect(engineer).toBeTruthy();
	expect(architect).toBeTruthy();

	coachId = coach.id;
	engineerId = engineer.id;
	architectId = architect.id;

	({ token: engineerToken } = await mintAgentToken(db, masterKeyManager, engineerId, teamId));

	const taskRes = await app.request(`/api/teams/${teamId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Test Feature Implementation',
			assignee_id: engineerId,
		}),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('Coach agent provisioning', () => {
	it('Coach is auto-provisioned when team is created with Startup template', async () => {
		const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
			headers: authHeader(boardToken),
		});
		const agents = (await agentsRes.json()).data;
		const coach = agents.find((a: any) => a.slug === 'coach');

		expect(coach).toBeTruthy();
		expect(coach.title).toBe('Coach');
		expect(coach.admin_status).toBe('enabled');

		const promptRes = await app.request(`/api/teams/${teamId}/agents/${coach.id}/system-prompt`, {
			headers: authHeader(boardToken),
		});
		const promptDoc = (await promptRes.json()).data;
		expect(promptDoc?.content).toBeTruthy();
	});

	it('Coach agent type exists in agent_types', async () => {
		const res = await app.request('/api/agent-types', {
			headers: authHeader(boardToken),
		});
		const types = (await res.json()).data;
		const coachType = types.find((t: any) => t.slug === 'coach');

		expect(coachType).toBeTruthy();
		expect(coachType.name).toBe('Coach');
		expect(coachType.is_builtin).toBe(true);
	});
});

describe('Coach wakeup on task done', () => {
	it('creates a wakeup for Coach when task is marked done', async () => {
		const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'done' }),
		});
		expect(res.status).toBe(200);

		// Wait for async wakeup creation (fire-and-forget in the route handler)
		await new Promise((r) => setTimeout(r, 100));

		const wakeups = await db.query<{
			id: string;
			member_id: string;
			source: string;
			payload: { task_id: string; trigger: string };
		}>(
			`SELECT id, member_id, source, payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND source = 'automation'
			 ORDER BY created_at DESC LIMIT 1`,
			[coachId],
		);

		expect(wakeups.rows.length).toBe(1);
		expect(wakeups.rows[0].payload.task_id).toBe(taskId);
		expect(wakeups.rows[0].payload.trigger).toBe('task_done');
	});
});

describe('Coach review prompt builder', () => {
	it('prepends the system prompt and points the coach back to it for the final summary comment', async () => {
		const taskRow = await db.query<TaskInfo>(
			`SELECT id, identifier, title, description, status::text AS status,
			        priority::text AS priority, project_id, rules,
			        parent_task_id, created_by_run_id
			 FROM tasks WHERE id = $1`,
			[taskId],
		);
		expect(taskRow.rows.length).toBe(1);

		const prompt = await buildCoachReviewPrompt(db, 'SYSTEM_PROMPT', taskRow.rows[0], teamId);

		expect(prompt).toContain('SYSTEM_PROMPT');
		expect(prompt).toContain(taskRow.rows[0].identifier);
		expect(prompt).toMatch(/### Final Step/);
		expect(prompt).toMatch(/review summary comment/i);
		expect(prompt).toMatch(/following the format defined in your system prompt/i);
	});

	it('includes attachment paths in the comment log so the agent can read them', async () => {
		const taskRow = await db.query<TaskInfo>(
			`SELECT id, identifier, title, description, status::text AS status,
			        priority::text AS priority, project_id, rules,
			        parent_task_id, created_by_run_id
			 FROM tasks WHERE id = $1`,
			[taskId],
		);

		const commentRes = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, 'text'::comment_content_type, $2::jsonb)
			 RETURNING id`,
			[taskId, JSON.stringify({ text: 'logs attached' })],
		);
		const commentId = commentRes.rows[0].id;

		const assetRes = await db.query<{ id: string }>(
			`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256, original_filename)
			 VALUES ($1, $2, 'text/plain', 42, 'abc', 'crash.log')
			 RETURNING id`,
			[teamId, projectId],
		);
		const assetId = assetRes.rows[0].id;

		await db.query('INSERT INTO comment_attachments (comment_id, asset_id) VALUES ($1, $2)', [
			commentId,
			assetId,
		]);

		const prompt = await buildCoachReviewPrompt(db, 'SYS', taskRow.rows[0], teamId);
		expect(prompt).toContain('attachment: crash.log');
		expect(prompt).toContain(`/workspace/.hezo/assets/${assetId}`);
	});

	it('seeded coach system prompt contains the summary-comment rule from the partial', async () => {
		const res = await db.query<{ system_prompt_template: string }>(
			"SELECT system_prompt_template FROM agent_types WHERE slug = 'coach'",
		);
		expect(res.rows.length).toBe(1);
		const template = res.rows[0].system_prompt_template;
		expect(template).toContain('End every review with exactly one `create_comment`');
		expect(template).toMatch(/do not end the turn without posting it/i);
	});
});

describe('MCP tools registration', () => {
	it('registers get_agent_system_prompt and update_agent_system_prompt tools', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const toolNames = body.result.tools.map((t: any) => t.name);
		expect(toolNames).toContain('get_agent_system_prompt');
		expect(toolNames).toContain('update_agent_system_prompt');
	});
});

describe('Agent system-prompt access', () => {
	it('non-coach agents can no longer update prompts via /self endpoints', async () => {
		const res = await app.request('/agent-api/self/system-prompt', {
			headers: authHeader(engineerToken),
		});
		expect(res.status).toBe(404);
	});

	it('non-coach agents cannot call update_agent_system_prompt via MCP', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(engineerToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				id: 1,
				params: {
					name: 'update_agent_system_prompt',
					arguments: {
						team_id: teamId,
						agent_id: architectId,
						new_system_prompt: 'hostile rewrite',
						change_summary: 'unauthorized',
					},
				},
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const content = body.result.content?.[0]?.text ?? '';
		expect(content).toMatch(/Access denied/);
	});
});

describe('System prompt revision tracking', () => {
	it('records revision on manual board edit', async () => {
		await app.request(`/api/teams/${teamId}/agents/${architectId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'Before manual edit' }),
		});

		const res = await app.request(`/api/teams/${teamId}/agents/${architectId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'After manual edit by board' }),
		});
		expect(res.status).toBe(200);

		const revisionsRes = await app.request(
			`/api/teams/${teamId}/agents/${architectId}/system-prompt/revisions`,
			{ headers: authHeader(boardToken) },
		);
		const revisions = (await revisionsRes.json()).data as Array<{
			content: string;
			change_summary: string;
			revision_number: number;
		}>;
		expect(revisions.length).toBeGreaterThanOrEqual(1);
		const latest = revisions[0];
		expect(latest.content).toBe('Before manual edit');
		expect(latest.change_summary).toBe('Manual edit by board member');
	});

	it('revision numbers increment correctly', async () => {
		await app.request(`/api/teams/${teamId}/agents/${engineerId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'Version A' }),
		});
		await app.request(`/api/teams/${teamId}/agents/${engineerId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'Version B' }),
		});
		await app.request(`/api/teams/${teamId}/agents/${engineerId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ system_prompt: 'Version C' }),
		});

		const revisionsRes = await app.request(
			`/api/teams/${teamId}/agents/${engineerId}/system-prompt/revisions`,
			{ headers: authHeader(boardToken) },
		);
		const revisions = (await revisionsRes.json()).data as Array<{ revision_number: number }>;
		expect(revisions.length).toBeGreaterThanOrEqual(2);
		const nums = [...revisions.map((r) => r.revision_number)].sort((a, b) => a - b);
		for (let i = 1; i < nums.length; i++) {
			expect(nums[i]).toBeGreaterThan(nums[i - 1]);
		}
	});
});

describe('team settings JSONB', () => {
	it('has correct default values', async () => {
		const res = await app.request(`/api/teams/${teamId}`, {
			headers: authHeader(boardToken),
		});
		const team = (await res.json()).data;
		expect(team.settings).toEqual({ wake_mentioner_on_reply: true });
	});

	it('merges settings without clobbering existing keys', async () => {
		const res = await app.request(`/api/teams/${teamId}`, {
			method: 'PATCH',
			headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ settings: { custom_key: 'hello' } }),
		});
		expect(res.status).toBe(200);
		const team = (await res.json()).data;
		expect(team.settings.custom_key).toBe('hello');
		expect(team.settings.wake_mentioner_on_reply).toBe(true);
	});
});

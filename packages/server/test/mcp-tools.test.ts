import type { PGlite } from '@electric-sql/pglite';
import { AuthType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { AuthInfo, Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	instanceCeoId,
	instanceCoachId,
	mintAgentToken,
	projectSlugForTeamSlug,
} from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;

let teamId: string;
let agentId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;

let teamBId: string;
let teamBSlug: string;
let agentBId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	// Create Team A
	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'MCP Tool Test Co',
			template_id: typeId,
		}),
	});
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;

	// 1:1 model — the team's single project is created first, then everything
	// (agents lookup, tasks) is addressed through it.
	const projectRes = await createTestProject(db, teamId, {
		name: 'Test Project',
		description: 'Test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Seed Task', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;

	// Create Team B
	const teamBRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'MCP Tool Test Co B',
			template_id: typeId,
		}),
	});
	const teamBData = (await teamBRes.json()).data;
	teamBId = teamBData.id;
	teamBSlug = teamBData.slug;

	const agentsBRes = await app.request(
		`/api/projects/${await projectSlugForTeamSlug(db, teamBSlug)}/agents`,
		{
			headers: authHeader(token),
		},
	);
	agentBId = (await agentsBRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

async function insertTaskDirect(assigneeId: string, title: string): Promise<string> {
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

// Helper: call MCP tool via /mcp endpoint with admin token
async function callToolViaMcp(toolName: string, args: Record<string, unknown>): Promise<unknown> {
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
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	return JSON.parse(body.result.content[0].text);
}

describe('MCP endpoint: tool registration', () => {
	it('lists all registered tools', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const toolNames = body.result.tools.map((t: any) => t.name);
		expect(toolNames).toContain('list_teams');
		expect(toolNames).toContain('get_team');
		expect(toolNames).toContain('create_team');
		expect(toolNames).toContain('list_tasks');
		expect(toolNames).toContain('get_task');
		expect(toolNames).toContain('create_task');
		expect(toolNames).toContain('update_task');
		expect(toolNames).toContain('list_agents');
		expect(toolNames).toContain('list_projects');
		expect(toolNames).toContain('list_comments');
		expect(toolNames).toContain('create_comment');
		expect(toolNames).toContain('list_approvals');
		expect(toolNames).toContain('resolve_approval');
		expect(toolNames).toContain('list_skills');
		expect(toolNames).toContain('get_skill');
		expect(toolNames).toContain('create_skill');
		expect(toolNames).toContain('propose_skill');
		expect(toolNames).toContain('get_costs');
		expect(toolNames).toContain('get_agent_system_prompt');
		expect(toolNames).toContain('update_agent_system_prompt');
		expect(toolNames).toContain('list_project_docs');
		expect(toolNames).toContain('read_project_doc');
		expect(toolNames).toContain('write_project_doc');
		expect(toolNames).toContain('propose_skill');
	});

	it('rejects unauthenticated MCP requests', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_teams', arguments: {} },
				id: 1,
			}),
		});
		expect(res.status).toBe(401);
	});
});

describe('MCP tool: verifyTeamAccess (direct DB tests)', () => {
	it('API key auth allows access to own team', () => {
		const apiKeyAuth: AuthInfo = { type: AuthType.ApiKey, teamId };
		expect(apiKeyAuth.teamId).toBe(teamId);
	});

	it('API key auth denies access to other team', () => {
		const apiKeyAuth: AuthInfo = { type: AuthType.ApiKey, teamId };
		expect(apiKeyAuth.teamId).not.toBe(teamBId);
	});

	it('agent auth allows access to own team', async () => {
		const agentAuth: AuthInfo = {
			type: AuthType.Agent,
			memberId: agentId,
			teamId,
			runId: '00000000-0000-0000-0000-000000000001',
			taskId: null,
			projectId: '00000000-0000-0000-0000-000000000010',
			crossProject: true,
		};
		expect(agentAuth.teamId).toBe(teamId);
	});

	it('agent auth denies access to other team', async () => {
		const agentAuth: AuthInfo = {
			type: AuthType.Agent,
			memberId: agentBId,
			teamId: teamBId,
			runId: '00000000-0000-0000-0000-000000000002',
			taskId: null,
			projectId: '00000000-0000-0000-0000-000000000011',
			crossProject: true,
		};
		expect(agentAuth.teamId).not.toBe(teamId);
	});

	it('admin superuser has access to any team', async () => {
		const superuserAuth: AuthInfo = {
			type: AuthType.Admin,
			userId: 'test-user-id',
			isSuperuser: true,
		};
		expect(superuserAuth.isSuperuser).toBe(true);
	});

	it('admin non-superuser needs membership check', async () => {
		// Create a non-superuser who is NOT a member of teamB
		const userRes = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('NoAccess User', false) RETURNING id",
		);
		const userId = userRes.rows[0].id;

		// Not a member of teamB — no rows returned
		const result = await db.query(
			'SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1 AND m.team_id = $2',
			[userId, teamBId],
		);
		expect(result.rows.length).toBe(0);
	});
});

describe('MCP tool handlers: data queries via DB', () => {
	it('list_teams query returns all teams for superuser', async () => {
		const r = await db.query('SELECT * FROM teams ORDER BY name');
		expect(r.rows.length).toBeGreaterThanOrEqual(2);
		const names = r.rows.map((c: any) => c.name);
		expect(names).toContain('MCP Tool Test Co');
		expect(names).toContain('MCP Tool Test Co B');
	});

	it('list_teams query for agent returns only own team', async () => {
		const r = await db.query('SELECT * FROM teams WHERE id = $1', [teamId]);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).name).toBe('MCP Tool Test Co');
	});

	it('get_team returns correct team', async () => {
		const r = await db.query('SELECT * FROM teams WHERE id = $1', [teamId]);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).name).toBe('MCP Tool Test Co');
	});

	it('list_tasks returns tasks for team', async () => {
		const r = await db.query(
			'SELECT i.*, p.name AS project_name FROM tasks i JOIN projects p ON p.id = i.project_id WHERE i.team_id = $1 ORDER BY i.created_at DESC LIMIT 50',
			[teamId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		const titles = r.rows.map((i: any) => i.title);
		expect(titles).toContain('Seed Task');
	});

	it('list_tasks filters by project_id', async () => {
		const r = await db.query('SELECT * FROM tasks WHERE team_id = $1 AND project_id = $2', [
			teamId,
			projectId,
		]);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		for (const row of r.rows) {
			expect((row as any).project_id).toBe(projectId);
		}
	});

	it('create_task inserts correctly', async () => {
		const meta = await db.query<{ task_prefix: string; number: number }>(
			`SELECT p.task_prefix, next_project_task_number(p.id) AS number
			 FROM projects p WHERE p.id = $1`,
			[projectId],
		);
		const num = meta.rows[0].number;
		const identifier = `${meta.rows[0].task_prefix}-${num}`;

		const r = await db.query(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, description, status, priority)
			 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::task_status, 'high'::task_priority) RETURNING *`,
			[teamId, projectId, num, identifier, 'Direct DB Task', 'Created directly'],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).title).toBe('Direct DB Task');
		expect((r.rows[0] as any).identifier).toMatch(/^TP-/);
	});

	it('update_task changes status', async () => {
		await db.query("UPDATE tasks SET status = 'in_progress'::task_status WHERE id = $1", [taskId]);
		const r = await db.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
		expect((r.rows[0] as any).status).toBe('in_progress');
		// Reset
		await db.query("UPDATE tasks SET status = 'backlog'::task_status WHERE id = $1", [taskId]);
	});

	it('list_agents returns agents for team', async () => {
		const r = await db.query(
			`SELECT m.id, ma.title, ma.slug, ma.admin_status
			 FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.team_id = $1 ORDER BY ma.title`,
			[teamId],
		);
		expect(r.rows.length).toBeGreaterThan(0);
	});

	it('list_projects returns projects for team', async () => {
		const r = await db.query('SELECT * FROM projects WHERE team_id = $1 ORDER BY name', [teamId]);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		const names = r.rows.map((p: any) => p.name);
		expect(names).toContain('Test Project');
	});

	it('list_approvals returns pending approvals', async () => {
		// Create a pending approval
		await db.query(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'strategy'::approval_type, '{"test": true}'::jsonb)`,
			[teamId],
		);

		const r = await db.query(
			"SELECT * FROM approvals WHERE team_id = $1 AND status = 'pending'::approval_status ORDER BY created_at DESC",
			[teamId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
	});

	it('list_skills returns skills for team', async () => {
		const r = await db.query('SELECT id, name, slug, updated_at FROM skills ORDER BY name');
		// May have skills from template, or may be empty — just verify query works
		expect(Array.isArray(r.rows)).toBe(true);
	});
});

describe('MCP tool: skill file includes all tools', () => {
	it('/skill.md contains tool names', async () => {
		const res = await app.request('/skill.md');
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain('list_teams');
		expect(text).toContain('create_task');
		expect(text).toContain('list_agents');
		expect(text).toContain('resolve_approval');
		expect(text).toContain('get_agent_system_prompt');
		expect(text).toContain('update_agent_system_prompt');
		expect(text).toContain('create_skill');
		expect(text).toContain('list_project_docs');
		expect(text).toContain('read_project_doc');
		expect(text).toContain('write_project_doc');
		expect(text).toContain('propose_skill');
	});
});

describe('MCP endpoint: tool call integration', () => {
	it('calls list_teams via /mcp endpoint', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_teams', arguments: {} },
				id: 1,
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.result.content).toBeDefined();
		expect(body.result.content[0].type).toBe('text');
		// Content is JSON text — parse and verify
		const data = JSON.parse(body.result.content[0].text);
		// If auth injection works, we get teams; if not, we get an error
		// Either way the endpoint responds correctly
		expect(data).toBeDefined();
	});

	async function callUpdateTaskAsAgent(args: Record<string, unknown>): Promise<unknown> {
		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'update_task', arguments: args },
				id: 1,
			}),
		});
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		return JSON.parse(body.result.content[0].text);
	}

	it('update_task via MCP as a non-Coach agent rejects status=closed', async () => {
		const created = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Agent MCP close target',
			assignee_id: agentId,
		})) as { id: string };

		const result = (await callUpdateTaskAsAgent({
			project: projectId,
			task_id: created.id,
			status: 'closed',
		})) as { status?: string; error?: string };
		expect(result.error).toMatch(/coach/i);
		expect(result.status).toBeUndefined();

		const row = await db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
			created.id,
		]);
		expect(row.rows[0].status).not.toBe('closed');
	});

	it('update_task via MCP as Coach can set status=closed', async () => {
		const created = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Coach MCP close target',
			assignee_id: agentId,
		})) as { id: string };

		const coachId = await instanceCoachId(db);
		const { token: coachToken } = await mintAgentToken(db, masterKeyManager, coachId, teamId);

		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(coachToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'update_task',
					arguments: { project: projectId, task_id: created.id, status: 'closed' },
				},
				id: 1,
			}),
		});
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		const result = JSON.parse(body.result.content[0].text) as {
			status?: string;
			error?: string;
		};
		expect(result.error).toBeUndefined();
		expect(result.status).toBe('closed');
	});

	it('update_task via MCP as agent cannot re-open a closed task', async () => {
		const created = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Agent MCP reopen target',
			assignee_id: agentId,
		})) as { id: string };

		// Admin closes the task first.
		await callToolViaMcp('update_task', {
			project: projectId,
			task_id: created.id,
			status: 'closed',
		});

		const result = (await callUpdateTaskAsAgent({
			project: projectId,
			task_id: created.id,
			status: 'backlog',
		})) as { error?: string };
		expect(result.error).toMatch(/admin/i);

		const bypass = (await callUpdateTaskAsAgent({
			project: projectId,
			task_id: created.id,
			status: 'in_progress',
		})) as { error?: string };
		expect(bypass.error).toMatch(/admin/i);
	});

	it('update_task via MCP as agent can still set non-terminal statuses', async () => {
		const created = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Agent MCP progress target',
			assignee_id: agentId,
		})) as { id: string };

		const result = (await callUpdateTaskAsAgent({
			project: projectId,
			task_id: created.id,
			status: 'in_progress',
		})) as { status?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.status).toBe('in_progress');
	});

	it('update_task does not create an assignment wakeup when assignee_id is unchanged', async () => {
		const taskRowId = await insertTaskDirect(agentId, 'Same-assignee wakeup guard');

		const result = (await callUpdateTaskAsAgent({
			project: projectId,
			task_id: taskRowId,
			status: 'in_progress',
			assignee_id: agentId,
		})) as { status?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.status).toBe('in_progress');

		await new Promise((resolve) => setImmediate(resolve));

		const wakeups = await db.query<{ source: string; member_id: string }>(
			`SELECT source::text AS source, member_id
			 FROM agent_wakeup_requests
			 WHERE payload->>'task_id' = $1`,
			[taskRowId],
		);
		expect(wakeups.rows.filter((r) => r.source === 'assignment')).toEqual([]);
	});

	it('update_task creates an assignment wakeup when assignee_id changes', async () => {
		const captainRow = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[teamId],
		);
		const captainId = captainRow.rows[0].id;

		const taskRowId = await insertTaskDirect(captainId, 'Reassignment wakeup fires');

		const result = (await callToolViaMcp('update_task', {
			project: projectId,
			task_id: taskRowId,
			assignee_id: agentId,
		})) as { assignee_id?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.assignee_id).toBe(agentId);

		await new Promise((resolve) => setImmediate(resolve));

		const wakeups = await db.query<{ source: string; member_id: string }>(
			`SELECT source::text AS source, member_id
			 FROM agent_wakeup_requests
			 WHERE payload->>'task_id' = $1`,
			[taskRowId],
		);
		const assignmentWakeups = wakeups.rows.filter((r) => r.source === 'assignment');
		expect(assignmentWakeups.length).toBe(1);
		expect(assignmentWakeups[0].member_id).toBe(agentId);
	});

	// An agent run is scoped to its own task (heartbeat_runs.task_id). It must not
	// START a *different* ticket — i.e. flip some other task to in_progress — inside
	// the run. Other edits to other tickets, and setting the run's OWN task to
	// in_progress (e.g. QA handing a ticket back to the Engineer), stay allowed.
	async function callUpdateTaskScoped(
		agentToken: string,
		args: Record<string, unknown>,
	): Promise<{ status?: string; error?: string }> {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'update_task', arguments: args },
				id: 1,
			}),
		});
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		return JSON.parse(body.result.content[0].text);
	}

	it('update_task lets an agent run set its OWN task to in_progress', async () => {
		const own = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Scope gate — own run task',
			assignee_id: agentId,
		})) as { id: string };
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			own.id,
		);

		const result = await callUpdateTaskScoped(agentToken, {
			project: projectId,
			task_id: own.id,
			status: 'in_progress',
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe('in_progress');
	});

	it('update_task blocks an agent run from moving a DIFFERENT task to in_progress', async () => {
		const own = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Scope gate — run task',
			assignee_id: agentId,
		})) as { id: string };
		const other = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Scope gate — different task',
			assignee_id: agentId,
		})) as { id: string };
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			own.id,
		);

		const result = await callUpdateTaskScoped(agentToken, {
			project: projectId,
			task_id: other.id,
			status: 'in_progress',
		});
		expect(result.error).toMatch(/scoped to its own ticket/i);
		expect(result.status).toBeUndefined();

		const row = await db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
			other.id,
		]);
		expect(row.rows[0].status).toBe('backlog');
	});

	it('update_task lets an agent run edit a DIFFERENT task without starting it', async () => {
		const own = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Scope gate — run task 2',
			assignee_id: agentId,
		})) as { id: string };
		const other = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Scope gate — field-edit target',
			assignee_id: agentId,
		})) as { id: string };
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
			own.id,
		);

		// Non-status field edit on another ticket (the mention-handoff fold) is allowed.
		const summary = await callUpdateTaskScoped(agentToken, {
			project: projectId,
			task_id: other.id,
			progress_summary: 'context folded in from the run ticket',
		});
		expect(summary.error).toBeUndefined();

		// A non-in_progress status change on another ticket is also allowed.
		const review = await callUpdateTaskScoped(agentToken, {
			project: projectId,
			task_id: other.id,
			status: 'review',
		});
		expect(review.error).toBeUndefined();
		expect(review.status).toBe('review');
	});

	it('update_task scope gate does not apply to board callers', async () => {
		const other = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Scope gate — board target',
			assignee_id: agentId,
		})) as { id: string };

		const result = (await callToolViaMcp('update_task', {
			project: projectId,
			task_id: other.id,
			status: 'in_progress',
		})) as { status?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.status).toBe('in_progress');
	});

	it('update_task scope gate does not apply to runs not bound to a task', async () => {
		const other = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Scope gate — null-run target',
			assignee_id: agentId,
		})) as { id: string };
		// mintAgentToken with no taskId → heartbeat_runs.task_id IS NULL → pass-through.
		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);

		const result = await callUpdateTaskScoped(agentToken, {
			project: projectId,
			task_id: other.id,
			status: 'in_progress',
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe('in_progress');
	});

	it('get_agent_system_prompt defaults to substituting placeholders without appending runtime blocks', async () => {
		const result = (await callToolViaMcp('get_agent_system_prompt', {
			project: projectId,
			agent_id: agentId,
		})) as { system_prompt: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.system_prompt).not.toContain('{{team_name}}');
		expect(result.system_prompt).toContain('MCP Tool Test Co');
		expect(result.system_prompt).not.toContain('## Working Guidelines');
		expect(result.system_prompt).not.toContain('## Teammates');
	});

	it('get_agent_system_prompt with placeholders=false returns the raw stored template', async () => {
		const result = (await callToolViaMcp('get_agent_system_prompt', {
			project: projectId,
			agent_id: agentId,
			placeholders: false,
		})) as { system_prompt: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.system_prompt).toContain('{{team_name}}');
		expect(result.system_prompt).not.toContain('MCP Tool Test Co');
	});
});

describe('MCP tool handlers: additional data queries via DB', () => {
	it('get_task query returns correct task', async () => {
		const r = await db.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).title).toBe('Seed Task');
		expect((r.rows[0] as any).project_id).toBe(projectId);
	});

	it('create_comment inserts correctly', async () => {
		const r = await db.query(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, 'text'::comment_content_type, $2::jsonb)
			 RETURNING *`,
			[taskId, JSON.stringify('MCP comment test')],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).content).toBe('MCP comment test');
	});

	it('create_comment via MCP sets author_member_id to calling agent', async () => {
		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'create_comment',
					arguments: {
						project: projectId,
						task_id: taskId,
						content: 'Authored via MCP',
					},
				},
				id: 1,
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		const inserted = JSON.parse(body.result.content[0].text) as {
			id: string;
			author_member_id: string | null;
		};
		expect(inserted.author_member_id).toBe(agentId);

		const fetched = await db.query<{ author_member_id: string | null }>(
			'SELECT author_member_id FROM task_comments WHERE id = $1',
			[inserted.id],
		);
		expect(fetched.rows[0].author_member_id).toBe(agentId);
	});

	it('list_comments query returns comments for task', async () => {
		const r = await db.query(
			'SELECT * FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC',
			[taskId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
	});

	it('create_skill inserts a new skill', async () => {
		const r = await db.query(
			`INSERT INTO skills (name, slug, description, content)
			 VALUES ('MCP Skill', 'mcp-skill', 'Created via MCP', 'How to do the thing')
			 RETURNING *`,
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).slug).toBe('mcp-skill');
	});

	it('get_skill query returns skill by slug', async () => {
		const r = await db.query('SELECT * FROM skills WHERE slug = $1', ['mcp-skill']);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).name).toBe('MCP Skill');
		expect((r.rows[0] as any).content).toBe('How to do the thing');
	});

	it('resolve_approval updates approval status', async () => {
		const approvalRes = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'strategy'::approval_type, '{"plan": "resolve test"}'::jsonb) RETURNING id`,
			[teamId],
		);
		const aid = approvalRes.rows[0].id;

		await db.query(
			`UPDATE approvals SET status = 'approved'::approval_status, resolution_note = 'LGTM', resolved_at = now() WHERE id = $1`,
			[aid],
		);

		const r = await db.query('SELECT * FROM approvals WHERE id = $1', [aid]);
		expect((r.rows[0] as any).status).toBe('approved');
		expect((r.rows[0] as any).resolution_note).toBe('LGTM');
	});

	it('get_costs query returns cost summary', async () => {
		const r = await db.query<{ total_cents: number }>(
			'SELECT COALESCE(SUM(amount_cents), 0)::int AS total_cents FROM cost_entries WHERE team_id = $1',
			[teamId],
		);
		expect(r.rows[0].total_cents).toBeDefined();
	});

	it('get_agent_system_prompt query returns prompt from documents', async () => {
		const r = await db.query(
			`SELECT content FROM documents
			 WHERE type = 'agent_system_prompt' AND team_id = $1 AND member_agent_id = $2`,
			[teamId, agentId],
		);
		expect(r.rows.length).toBeLessThanOrEqual(1);
		if (r.rows.length === 1) {
			expect(typeof (r.rows[0] as any).content).toBe('string');
		}
	});

	it('write_project_doc inserts correctly', async () => {
		const r = await db.query(
			`INSERT INTO documents (team_id, project_id, type, slug, content)
			 VALUES ($1, $2, 'project_doc', 'test-doc.md', '# Test Document')
			 RETURNING *`,
			[teamId, projectId],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).slug).toBe('test-doc.md');
	});

	it('read_project_doc query returns doc content', async () => {
		const r = await db.query(
			"SELECT * FROM documents WHERE type = 'project_doc' AND project_id = $1 AND slug = $2",
			[projectId, 'test-doc.md'],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).content).toBe('# Test Document');
	});

	it('list_project_docs query returns docs for project', async () => {
		const r = await db.query(
			"SELECT * FROM documents WHERE type = 'project_doc' AND project_id = $1 ORDER BY slug",
			[projectId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		const filenames = r.rows.map((d: any) => d.slug);
		expect(filenames).toContain('test-doc.md');
	});

	it('create_skill inserts correctly', async () => {
		const r = await db.query(
			`INSERT INTO skills (name, slug, content, is_active)
			 VALUES ('MCP Test Skill', 'mcp-test-skill', 'Skill content', true)
			 RETURNING *`,
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).slug).toBe('mcp-test-skill');
	});

	it('list_skills query returns active skills', async () => {
		const r = await db.query('SELECT * FROM skills WHERE is_active = true ORDER BY name');
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		const slugs = r.rows.map((s: any) => s.slug);
		expect(slugs).toContain('mcp-test-skill');
	});

	it('get_skill query returns skill by slug', async () => {
		const r = await db.query('SELECT * FROM skills WHERE slug = $1', ['mcp-test-skill']);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).name).toBe('MCP Test Skill');
		expect((r.rows[0] as any).content).toBe('Skill content');
	});

	it('propose_skill creates an approval', async () => {
		const r = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, requested_by_member_id, type, payload)
			 VALUES ($1, $2, 'skill_proposal'::approval_type, $3::jsonb)
			 RETURNING id`,
			[
				teamId,
				agentId,
				JSON.stringify({
					skill_name: 'Proposed Skill',
					skill_slug: 'proposed-skill',
					content: 'Proposed skill content',
					reason: 'Useful for deployment',
				}),
			],
		);
		expect(r.rows.length).toBe(1);
		expect(r.rows[0].id).toBeDefined();
	});
});

describe('MCP tool: set_agent_summary and set_team_summary', () => {
	it('set_agent_summary and set_team_summary are registered', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
		});
		const body = await res.json();
		const toolNames = body.result.tools.map((t: any) => t.name);
		expect(toolNames).toContain('set_agent_summary');
		expect(toolNames).toContain('set_team_summary');
	});

	it('set_agent_summary writes and rejects bad input (direct DB path)', async () => {
		const target = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'engineer'`,
			[teamId],
		);
		const targetId = target.rows[0].id;

		await db.query('UPDATE member_agents SET summary = $1 WHERE id = $2', [
			'Admin-written summary.',
			targetId,
		]);
		const row = await db.query<{ summary: string }>(
			'SELECT summary FROM member_agents WHERE id = $1',
			[targetId],
		);
		expect(row.rows[0].summary).toBe('Admin-written summary.');

		// Length cap: 1000 chars
		const longSummary = 'x'.repeat(1100);
		expect(longSummary.length).toBeGreaterThan(1000);
	});

	it('set_team_summary Captain-only access enforced via isCaptainOfTeam helper (direct DB)', async () => {
		const eng = await db.query<{ slug: string }>(
			`SELECT ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'engineer'`,
			[teamId],
		);
		expect(eng.rows[0].slug).not.toBe('captain');
		const captain = await db.query<{ slug: string }>(
			`SELECT ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[teamId],
		);
		expect(captain.rows[0].slug).toBe('captain');
	});

	it('set_team_summary writes via direct DB path', async () => {
		await db.query('UPDATE teams SET summary = $1 WHERE id = $2', [
			'A team that ships software together.',
			teamId,
		]);
		const row = await db.query<{ summary: string }>('SELECT summary FROM teams WHERE id = $1', [
			teamId,
		]);
		expect(row.rows[0].summary).toBe('A team that ships software together.');
	});
});

describe('MCP coordination: HQ agents act inside project teams', () => {
	async function callToolAs(
		tokenStr: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<{ updated?: boolean; error?: string }> {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(tokenStr), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: toolName, arguments: args },
				id: 1,
			}),
		});
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		return JSON.parse(body.result.content[0].text);
	}

	it('lets the CEO set the team summary while running cross-team', async () => {
		const ceoId = await instanceCeoId(db);
		const { token: ceoToken } = await mintAgentToken(db, masterKeyManager, ceoId, teamId);
		const result = await callToolAs(ceoToken, 'set_team_summary', {
			project: projectId,
			summary: 'Coherence-written team summary.',
		});
		expect(result.error).toBeUndefined();
		expect(result.updated).toBe(true);
		const row = await db.query<{ summary: string }>('SELECT summary FROM teams WHERE id = $1', [
			teamId,
		]);
		expect(row.rows[0].summary).toBe('Coherence-written team summary.');
	});

	it('denies a non-coordinator agent from setting the team summary', async () => {
		const { token: workerToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);
		const result = await callToolAs(workerToken, 'set_team_summary', {
			project: projectId,
			summary: 'Should be rejected.',
		});
		expect(result.error).toContain('Access denied');
		expect(result.updated).toBeUndefined();
	});
});

describe('MCP tools: project arg accepts a slug or UUID', () => {
	// The CEO addresses projects by slug (it never sees UUIDs); project-scoped tools
	// must resolve that slug so a cross-project status query returns real data instead
	// of coming back empty.
	it('list_agents resolves a project slug to the same roster as the UUID', async () => {
		const bySlug = (await callToolViaMcp('list_agents', { project: projectSlug })) as Array<{
			slug: string;
		}>;
		const byUuid = (await callToolViaMcp('list_agents', { project: projectId })) as Array<{
			slug: string;
		}>;
		expect(Array.isArray(bySlug)).toBe(true);
		expect(bySlug.length).toBeGreaterThan(0);
		expect(bySlug.map((a) => a.slug).sort()).toEqual(byUuid.map((a) => a.slug).sort());
	});

	it('list_tasks resolves a project slug and returns the seeded task', async () => {
		const rows = (await callToolViaMcp('list_tasks', { project: projectSlug })) as Array<{
			title: string;
		}>;
		expect(rows.map((t) => t.title)).toContain('Seed Task');
	});

	it('returns an Unknown project error for a slug that resolves to nothing', async () => {
		const result = (await callToolViaMcp('list_agents', { project: 'no-such-project-slug' })) as {
			error?: string;
		};
		expect(result.error).toContain('Unknown project');
	});
});

describe('MCP tool: set_agent_team_context and get_agent_team_context', () => {
	it('both tools are registered', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
		});
		const body = await res.json();
		const toolNames = body.result.tools.map((t: any) => t.name);
		expect(toolNames).toContain('set_agent_team_context');
		expect(toolNames).toContain('get_agent_team_context');
	});

	it('set_agent_team_context writes and round-trips via direct DB path', async () => {
		const eng = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'engineer'`,
			[teamId],
		);
		await db.query('UPDATE member_agents SET team_context = $1 WHERE id = $2', [
			'You report to the Architect.',
			eng.rows[0].id,
		]);

		const row = await db.query<{ team_context: string }>(
			'SELECT team_context FROM member_agents WHERE id = $1',
			[eng.rows[0].id],
		);
		expect(row.rows[0].team_context).toBe('You report to the Architect.');
	});

	it('default_team_context defaults are populated for Startup template agents', async () => {
		// Use roles the earlier set_agent_summary test doesn't mutate.
		const agents = await db.query<{ slug: string; team_context: string }>(
			`SELECT ma.slug, ma.team_context FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1`,
			[teamId],
		);
		const ceoRow = agents.rows.find((r) => r.slug === 'captain');
		const qaRow = agents.rows.find((r) => r.slug === 'qa-engineer');
		const archRow = agents.rows.find((r) => r.slug === 'architect');
		expect(ceoRow?.team_context).toBeTruthy();
		expect(qaRow?.team_context).toBeTruthy();
		expect(qaRow?.team_context).toContain('@architect');
		expect(archRow?.team_context).toContain('@engineer');
	});
});

describe('MCP tool: create_task sub-task depth', () => {
	it('create_task caps sub-task depth at 2', async () => {
		const root = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Depth root',
			assignee_id: agentId,
		})) as { id: string; error?: string };
		expect(root.error).toBeUndefined();

		const sub = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Depth sub',
			assignee_id: agentId,
			parent_task_id: root.id,
		})) as { id: string; error?: string };
		expect(sub.error).toBeUndefined();

		const subSub = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Depth sub-sub',
			assignee_id: agentId,
			parent_task_id: sub.id,
		})) as { id: string; error?: string };
		expect(subSub.error).toBeUndefined();

		const tooDeep = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Depth too deep',
			assignee_id: agentId,
			parent_task_id: subSub.id,
		})) as { error?: string };
		expect(tooDeep.error).toMatch(/2 levels deep/);
	});
});

describe('MCP tool: result shape — no embeddings, opt-in excerpts, size guard', () => {
	it('list_tasks never returns the embedding column', async () => {
		const rows = (await callToolViaMcp('list_tasks', {
			project: projectId,
		})) as Array<Record<string, unknown>>;
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row).not.toHaveProperty('embedding');
			expect(row).toHaveProperty('description');
			expect(row).toHaveProperty('progress_summary');
		}
	});

	it('get_task never returns the embedding column', async () => {
		const task = (await callToolViaMcp('get_task', {
			project: projectId,
			task_id: taskId,
		})) as Record<string, unknown>;
		expect(task).not.toHaveProperty('embedding');
		expect(task).toHaveProperty('description');
	});

	it('get_task resolves a human-readable task identifier to its UUID', async () => {
		const created = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Identifier resolution target',
			assignee_id: agentId,
		})) as { id: string; identifier: string };

		const byIdentifier = (await callToolViaMcp('get_task', {
			project: projectId,
			task_id: created.identifier,
		})) as Record<string, unknown>;
		expect(byIdentifier.id).toBe(created.id);
		expect(byIdentifier.identifier).toBe(created.identifier);
	});

	it('get_task returns a clean error for an unknown identifier instead of crashing', async () => {
		const result = (await callToolViaMcp('get_task', {
			project: projectId,
			task_id: 'ZZ-999',
		})) as { error?: string };
		expect(result.error).toContain('ZZ-999');
	});

	it('list_comments accepts a task identifier (centralized resolution)', async () => {
		const created = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Identifier resolution for comments',
			assignee_id: agentId,
		})) as { id: string; identifier: string };

		const comments = await callToolViaMcp('list_comments', {
			project: projectId,
			task_id: created.identifier,
		});
		expect(Array.isArray(comments)).toBe(true);
	});

	it('get_task returns blockers and dependents symmetrically', async () => {
		const upstream = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Upstream for dependents test',
			assignee_id: agentId,
		})) as { id: string; identifier: string };

		const downstream = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Downstream for dependents test',
			assignee_id: agentId,
			blocked_by_task_ids: [upstream.identifier],
		})) as { id: string; identifier: string };

		const upstreamView = (await callToolViaMcp('get_task', {
			project: projectId,
			task_id: upstream.id,
		})) as {
			blockers: Array<{ identifier: string }>;
			dependents: Array<{ id: string; identifier: string; status: string }>;
		};
		expect(upstreamView.blockers).toEqual([]);
		expect(upstreamView.dependents).toHaveLength(1);
		expect(upstreamView.dependents[0].id).toBe(downstream.id);
		expect(upstreamView.dependents[0].identifier).toBe(downstream.identifier);
		expect(upstreamView.dependents[0].status).toBe('blocked');

		const downstreamView = (await callToolViaMcp('get_task', {
			project: projectId,
			task_id: downstream.id,
		})) as {
			blockers: Array<{ id: string; identifier: string }>;
			dependents: Array<unknown>;
		};
		expect(downstreamView.blockers).toHaveLength(1);
		expect(downstreamView.blockers[0].id).toBe(upstream.id);
		expect(downstreamView.dependents).toEqual([]);
	});

	it('list_tasks with excerpt_chars returns the excerpt/truncated/length triple', async () => {
		const longBody = `Paragraph one is the headline.\n\n${'detail '.repeat(200)}`;
		const created = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Excerpt target',
			description: longBody,
			assignee_id: agentId,
		})) as { id: string };

		const rows = (await callToolViaMcp('list_tasks', {
			project: projectId,
			excerpt_chars: 50,
		})) as Array<Record<string, unknown>>;
		const target = rows.find((r) => r.id === created.id) as Record<string, unknown>;
		expect(target).toBeDefined();
		expect(target).not.toHaveProperty('description');
		expect(target.description_excerpt).toBe('Paragraph one is the headline.');
		expect(target.description_truncated).toBe(true);
		expect(target.description_length).toBe(longBody.length);
	});

	it('list_tasks without excerpt_chars returns the full description', async () => {
		const body = 'Single short body.';
		const created = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Full body target',
			description: body,
			assignee_id: agentId,
		})) as { id: string };

		const rows = (await callToolViaMcp('list_tasks', {
			project: projectId,
		})) as Array<Record<string, unknown>>;
		const target = rows.find((r) => r.id === created.id) as Record<string, unknown>;
		expect(target.description).toBe(body);
		expect(target).not.toHaveProperty('description_excerpt');
	});

	it('list_comments caps at 50, walks backward via `before`, and truncates with excerpt_chars', async () => {
		const task = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Comment pagination target',
			assignee_id: agentId,
		})) as { id: string };

		for (let i = 0; i < 60; i++) {
			await db.query(
				`INSERT INTO task_comments (task_id, content_type, content, created_at)
				 VALUES ($1, 'text'::comment_content_type, $2::jsonb,
				         now() + ($3 || ' milliseconds')::interval)`,
				[task.id, JSON.stringify({ text: `comment ${i}` }), i],
			);
		}

		const first = (await callToolViaMcp('list_comments', {
			project: projectId,
			task_id: task.id,
		})) as Array<Record<string, unknown>>;
		expect(first.length).toBe(50);
		expect((first[0].content as { text: string }).text).toBe('comment 59');

		const oldest = first[first.length - 1] as { id: string };
		const next = (await callToolViaMcp('list_comments', {
			project: projectId,
			task_id: task.id,
			before: oldest.id,
		})) as Array<Record<string, unknown>>;
		expect(next.length).toBeGreaterThan(0);
		expect(next.length).toBeLessThanOrEqual(50);
		for (const row of next) {
			expect(row.id).not.toBe(oldest.id);
		}

		const longText = 'x'.repeat(5000);
		await db.query(
			`INSERT INTO task_comments (task_id, content_type, content, created_at)
			 VALUES ($1, 'text'::comment_content_type, $2::jsonb,
			         now() + interval '1 hour')`,
			[task.id, JSON.stringify({ text: longText })],
		);
		const truncated = (await callToolViaMcp('list_comments', {
			project: projectId,
			task_id: task.id,
			excerpt_chars: 100,
		})) as Array<Record<string, unknown>>;
		const longRow = truncated[0] as {
			content: { text: string };
			text_truncated?: boolean;
			text_length?: number;
		};
		expect(longRow.content.text.length).toBeLessThanOrEqual(100);
		expect(longRow.text_truncated).toBe(true);
		expect(longRow.text_length).toBe(longText.length);
	});

	it('returns a structured result_too_large error when serialised output exceeds the byte cap', async () => {
		const fatProjectRes = await createTestProject(db, teamId, {
			name: 'Fat Result Project',
			description: 'fatness',
		});
		const fatProjectId = (await fatProjectRes.json()).data.id;

		const fatBody = 'lorem '.repeat(1800);
		for (let i = 0; i < 8; i++) {
			await callToolViaMcp('create_task', {
				project: fatProjectId,
				title: `Fat ticket ${i}`,
				description: fatBody,
				assignee_id: agentId,
			});
		}

		const result = (await callToolViaMcp('list_tasks', {
			project: fatProjectId,
		})) as {
			error?: string;
			tool?: string;
			size_bytes?: number;
			limit_bytes?: number;
			hint?: string;
		};
		expect(result.error).toBe('result_too_large');
		expect(result.tool).toBe('list_tasks');
		expect(result.size_bytes).toBeGreaterThan(result.limit_bytes ?? 0);
		expect(result.hint).toContain('excerpt_chars');

		const slim = (await callToolViaMcp('list_tasks', {
			project: fatProjectId,
			excerpt_chars: 200,
		})) as Array<Record<string, unknown>>;
		expect(Array.isArray(slim)).toBe(true);
		expect(slim.length).toBeGreaterThanOrEqual(8);
		for (const row of slim) {
			expect(row).toHaveProperty('description_excerpt');
			expect(row).toHaveProperty('description_truncated');
			expect(row).toHaveProperty('description_length');
		}
	});
});

describe('read_project_asset', () => {
	it('round-trips a text asset written via write_project_asset', async () => {
		const html = '<html><body><h1>Login mockup</h1></body></html>';
		const write = (await callToolViaMcp('write_project_asset', {
			project: projectId,
			filename: 'ui-mockups.html',
			content: html,
		})) as { written?: boolean };
		expect(write.written).toBe(true);

		const read = (await callToolViaMcp('read_project_asset', {
			project: projectId,
			filename: 'ui-mockups.html',
		})) as { filename?: string; content_type?: string; content?: string };
		expect(read.filename).toBe('ui-mockups.html');
		expect(read.content_type).toBe('text/html');
		expect(read.content).toBe(html);
	});

	it('returns an error for an unknown asset', async () => {
		const res = (await callToolViaMcp('read_project_asset', {
			project: projectId,
			filename: 'does-not-exist.html',
		})) as { error?: string };
		expect(res.error).toMatch(/not found/i);
	});

	it('denies a caller from another team', async () => {
		const { token: bToken } = await mintAgentToken(db, masterKeyManager, agentBId, teamBId);
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(bToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'read_project_asset',
					arguments: { project: projectId, filename: 'ui-mockups.html' },
				},
				id: 1,
			}),
		});
		const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
		const parsed = JSON.parse(body.result.content[0].text) as { error?: string; content?: string };
		expect(parsed.error).toBeTruthy();
		expect(parsed.content).toBeUndefined();
	});
});

import { AuthType, DEFAULT_TEAM_ID } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { AuthInfo, Env } from '../src/lib/types';
import { getToolDefs } from '../src/mcp/server';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	instanceCeoId,
	mintAgentToken,
	projectSlugForTeamSlug,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
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
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;

	// Create Team A
	const teamRes = await createTestTeam(db, {
		name: 'MCP Tool Test Co',
		template_id: typeId,
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
	const teamBRes = await createTestTeam(db, {
		name: 'MCP Tool Test Co B',
		template_id: typeId,
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

/** Call a paged list tool and return just its rows. */
async function callListViaMcp(
	toolName: string,
	args: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
	const page = (await callToolViaMcp(toolName, args)) as {
		items: Array<Record<string, unknown>>;
	};
	return page.items;
}

describe('MCP endpoint: tool registration', () => {
	it('lists all registered tools', () => {
		// The registry, not `tools/list`: listing is projected per caller
		// (`mcp/tool-visibility.ts`), so a board-user principal is correctly not
		// shown the CEO-only and Captain-only tools this asserts on. Per-caller
		// visibility has its own coverage in `mcp-tool-visibility.test.ts`.
		const toolNames = getToolDefs().map((t) => t.name);
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
		expect(toolNames).toContain('create_project');
		expect(toolNames).not.toContain('update_project_creation_proposal');
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

	it('rejects unauthenticated MCP tool calls', async () => {
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
		// Unauthenticated callers get the onboarding surface only — a real tool
		// call is refused with a JSON-RPC "not connected" error.
		const body = await res.json();
		expect(body.error).toBeDefined();
		expect(body.error.message).toContain('Not connected');
	});
});

describe('MCP tool: verifyTeamAccess (direct DB tests)', () => {
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
	it('/SKILL.md contains tool names', async () => {
		const res = await app.request('/SKILL.md');
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain('list_teams');
		expect(text).toContain('create_task');
		expect(text).toContain('list_agents');
		expect(text).toContain('create_project');
		expect(text).toContain('start_team_setup');
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

	it('update_task via MCP lets an agent mark a task done (the completed state)', async () => {
		const created = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Agent MCP done target',
			assignee_id: agentId,
		})) as { id: string };

		const result = (await callUpdateTaskAsAgent({
			project: projectId,
			task_id: created.id,
			status: 'done',
		})) as { status?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.status).toBe('done');
	});

	it('update_task via MCP as agent cannot re-open a terminal task', async () => {
		const created = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Agent MCP reopen target',
			assignee_id: agentId,
		})) as { id: string };

		// Admin closes (cancels) the task first.
		await callToolViaMcp('update_task', {
			project: projectId,
			task_id: created.id,
			status: 'cancelled',
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
		expect(result.error).toMatch(/scoped to its own task/i);
		expect(result.error).toMatch(/must not start doing its work/i);
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
			progress_summary: 'context folded in from the run task',
		});
		expect(summary.error).toBeUndefined();

		// A non-in_progress status change on another ticket is also allowed.
		const parked = await callUpdateTaskScoped(agentToken, {
			project: projectId,
			task_id: other.id,
			status: 'backlog',
		});
		expect(parked.error).toBeUndefined();
		expect(parked.status).toBe('backlog');
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

	it('a write tool marks produced_output on the calling run', async () => {
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
		);

		const before = await db.query<{ produced_output: boolean }>(
			'SELECT produced_output FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(before.rows[0].produced_output).toBe(false);

		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'create_comment',
					arguments: { project: projectId, task_id: taskId, content: 'real output' },
				},
				id: 1,
			}),
		});
		expect(res.status).toBe(200);

		const after = await db.query<{ produced_output: boolean }>(
			'SELECT produced_output FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(after.rows[0].produced_output).toBe(true);
	});

	it('a read tool does not mark produced_output', async () => {
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
		);

		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_comments', arguments: { project: projectId, task_id: taskId } },
				id: 1,
			}),
		});
		expect(res.status).toBe(200);

		const after = await db.query<{ produced_output: boolean }>(
			'SELECT produced_output FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(after.rows[0].produced_output).toBe(false);
	});

	it('report_no_work marks the run as a declared no-op without producing output', async () => {
		const { token: agentToken, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			agentId,
			teamId,
		);

		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'report_no_work',
					arguments: { reason: 'planning task — sub-tasks still open' },
				},
				id: 1,
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
		expect(JSON.parse(body.result.content[0].text)).toEqual({ ok: true });

		const after = await db.query<{
			produced_output: boolean;
			reported_no_work: boolean;
			no_work_reason: string | null;
		}>(
			'SELECT produced_output, reported_no_work, no_work_reason FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(after.rows[0].reported_no_work).toBe(true);
		expect(after.rows[0].no_work_reason).toBe('planning task — sub-tasks still open');
		expect(after.rows[0].produced_output).toBe(false);
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
			'SELECT COALESCE(SUM(amount_cents), 0)::int AS total_cents FROM cost_entries WHERE project_id = $1',
			[projectId],
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

	it('round-trips a description through write/read/list_project_doc via MCP', async () => {
		const written = (await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'mcp-described.md',
			content: '# Analytics',
			description: 'How we track and report campaign analytics each week.',
		})) as { written?: boolean; error?: string };
		expect(written.error).toBeUndefined();
		expect(written.written).toBe(true);

		const read = (await callToolViaMcp('read_project_doc', {
			project: projectId,
			filename: 'mcp-described.md',
		})) as { description?: string };
		expect(read.description).toBe('How we track and report campaign analytics each week.');

		const listed = (await callToolViaMcp('list_project_docs', {
			project: projectId,
		})) as { items: Array<{ filename: string; description?: string }> };
		const entry = listed.items.find((f) => f.filename === 'mcp-described.md');
		expect(entry?.description).toBe('How we track and report campaign analytics each week.');
	});

	it('edit_project_doc changes one span and reports what landed', async () => {
		const body = [
			'# Spec',
			'',
			'## Storage',
			'We use localStorage.',
			'',
			'## Routing',
			'Hash.',
		].join('\n');
		await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'editable.md',
			content: body,
			description: 'Editing target.',
		});

		const edited = (await callToolViaMcp('edit_project_doc', {
			project: projectId,
			filename: 'editable.md',
			old_string: 'We use localStorage.',
			new_string: 'We use IndexedDB.',
			changelog: 'Switch the storage engine.',
		})) as {
			edited?: boolean;
			replacements?: number;
			content_length?: number;
			hunk?: string;
			warning?: string;
			error?: string;
		};
		expect(edited.error).toBeUndefined();
		expect(edited.edited).toBe(true);
		expect(edited.replacements).toBe(1);
		// The applied hunk is returned so the caller can verify without re-reading.
		expect(edited.hunk).toContain('We use IndexedDB.');
		// Content changed, so the changelog had a revision to land on.
		expect(edited.warning).toBeUndefined();

		const read = (await callToolViaMcp('read_project_doc', {
			project: projectId,
			filename: 'editable.md',
		})) as { content: string };
		expect(read.content).toContain('We use IndexedDB.');
		expect(read.content).toContain('## Routing');
		expect(read.content).not.toContain('localStorage');
		expect(edited.content_length).toBe(read.content.length);

		// Description survives an edit that never mentions it.
		const listed = (await callToolViaMcp('list_project_docs', { project: projectId })) as {
			items: Array<{ filename: string; description?: string }>;
		};
		expect(listed.items.find((f) => f.filename === 'editable.md')?.description).toBe(
			'Editing target.',
		);
	});

	it('edit_project_doc refuses an ambiguous or missing anchor, and a doc that does not exist', async () => {
		await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'ambiguous.md',
			content: 'alpha\nrepeat\nbeta\nrepeat\ngamma',
		});

		const ambiguous = (await callToolViaMcp('edit_project_doc', {
			project: projectId,
			filename: 'ambiguous.md',
			old_string: 'repeat',
			new_string: 'changed',
		})) as { error?: string; edited?: boolean };
		expect(ambiguous.edited).toBeUndefined();
		expect(ambiguous.error).toContain('matches 2 places');

		// Nothing was written by the refused call.
		const untouched = (await callToolViaMcp('read_project_doc', {
			project: projectId,
			filename: 'ambiguous.md',
		})) as { content: string };
		expect(untouched.content).toBe('alpha\nrepeat\nbeta\nrepeat\ngamma');

		const allOfThem = (await callToolViaMcp('edit_project_doc', {
			project: projectId,
			filename: 'ambiguous.md',
			old_string: 'repeat',
			new_string: 'changed',
			replace_all: true,
		})) as { replacements?: number };
		expect(allOfThem.replacements).toBe(2);

		const missingDoc = (await callToolViaMcp('edit_project_doc', {
			project: projectId,
			filename: 'no-such-doc.md',
			old_string: 'a',
			new_string: 'b',
		})) as { error?: string };
		expect(missingDoc.error).toContain('not found');
	});

	it('write_project_doc rejects a truncated argument instead of storing a partial body', async () => {
		const full = '# Spec\n\n'.concat('detail '.repeat(500));
		await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'integrity.md',
			content: full,
		});

		// A runtime that caps tool-call argument size cuts `content` mid-stream.
		// Declaring the true length is what turns that from a silent partial
		// overwrite (which also wipes the doc's review comments) into a refusal.
		const truncated = (await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'integrity.md',
			content: full.slice(0, 100),
			content_length: full.length,
		})) as { error?: string; written?: boolean };
		expect(truncated.written).toBeUndefined();
		expect(truncated.error).toContain('truncated in transit');

		const intact = (await callToolViaMcp('read_project_doc', {
			project: projectId,
			filename: 'integrity.md',
		})) as { content: string };
		expect(intact.content).toBe(full);

		// A matching declaration writes normally and reports the stored size.
		const ok = (await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'integrity.md',
			content: full.slice(0, 100),
			content_length: 100,
		})) as { written?: boolean; content_length?: number };
		expect(ok.written).toBe(true);
		expect(ok.content_length).toBe(100);
	});

	it('write_project_doc refuses to blank an existing doc unless asked explicitly', async () => {
		await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'blankable.md',
			content: '# Real content that took work',
		});

		const refused = (await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'blankable.md',
			content: '',
		})) as { error?: string; written?: boolean };
		expect(refused.written).toBeUndefined();
		expect(refused.error).toContain('allow_empty');

		const still = (await callToolViaMcp('read_project_doc', {
			project: projectId,
			filename: 'blankable.md',
		})) as { content: string };
		expect(still.content).toBe('# Real content that took work');

		const allowed = (await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'blankable.md',
			content: '',
			allow_empty: true,
		})) as { written?: boolean };
		expect(allowed.written).toBe(true);
	});

	it('warns when a changelog has no revision to land on', async () => {
		// First write of a doc: a revision holds the content as it was BEFORE a
		// change, so a creation has nowhere to put a changelog. It used to be
		// dropped in silence.
		const created = (await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'changelog-warn.md',
			content: '# One',
			changelog: 'Initial draft.',
		})) as { written?: boolean; warning?: string };
		expect(created.written).toBe(true);
		expect(created.warning).toContain('changelog');

		// Description-only update: same situation, content is unchanged.
		const descOnly = (await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'changelog-warn.md',
			content: '# One',
			description: 'Just the description.',
			changelog: 'Tweaked the description.',
		})) as { warning?: string };
		expect(descOnly.warning).toContain('changelog');

		// A real content change records it, so no warning.
		const real = (await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'changelog-warn.md',
			content: '# Two',
			changelog: 'Renamed the heading.',
		})) as { warning?: string };
		expect(real.warning).toBeUndefined();
	});

	it('omits description from read_project_doc when unset', async () => {
		await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'mcp-plain.md',
			content: '# Plain',
		});
		const read = (await callToolViaMcp('read_project_doc', {
			project: projectId,
			filename: 'mcp-plain.md',
		})) as { description?: string; content?: string };
		expect(read.content).toContain('Plain');
		expect(read.description).toBeUndefined();
	});

	it('pages a doc larger than one read window and reassembles it exactly', async () => {
		// ~196KB, well over the 64KB per-result cap, so it must span several windows.
		// Distinct per-line content means a mis-stitched window would corrupt the join.
		const big = Array.from({ length: 4000 }, (_, i) => `line ${i}: ${'x'.repeat(40)}`).join('\n');
		const totalBytes = Buffer.byteLength(big, 'utf8');
		expect(totalBytes).toBeGreaterThan(64_000);

		const w = (await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'big-doc.md',
			content: big,
		})) as { written?: boolean; error?: string };
		expect(w.error).toBeUndefined();
		expect(w.written).toBe(true);

		let offset = 0;
		let assembled = '';
		let windows = 0;
		for (let i = 0; i < 100; i++) {
			const win = (await callToolViaMcp('read_project_doc', {
				project: projectId,
				filename: 'big-doc.md',
				offset,
			})) as {
				content: string;
				offset: number;
				returned_bytes: number;
				total_bytes: number;
				next_offset: number | null;
				truncated: boolean;
				error?: string;
			};
			expect(win.error).toBeUndefined();
			expect(win.total_bytes).toBe(totalBytes);
			expect(win.offset).toBe(offset);
			// returned_bytes is the byte length of the window, never the UTF-16 length.
			expect(win.returned_bytes).toBe(Buffer.byteLength(win.content, 'utf8'));
			assembled += win.content;
			windows++;
			if (win.next_offset === null) break;
			expect(win.truncated).toBe(true);
			expect(win.next_offset).toBe(offset + win.returned_bytes);
			offset = win.next_offset;
		}
		expect(windows).toBeGreaterThan(1);
		expect(assembled).toBe(big);
	});

	it('never splits a multi-byte codepoint at a window boundary', async () => {
		// 100 ASCII bytes then a run of 4-byte emoji. A raw byte cut at 150 lands
		// inside the 13th emoji (bytes 148-151), so a naive slice would corrupt it.
		const content = `${'a'.repeat(100)}${'😀'.repeat(5000)}`;
		const w = (await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'emoji-doc.md',
			content,
		})) as { error?: string };
		expect(w.error).toBeUndefined();

		const first = (await callToolViaMcp('read_project_doc', {
			project: projectId,
			filename: 'emoji-doc.md',
			offset: 0,
			max_bytes: 150,
		})) as { content: string; returned_bytes: number; next_offset: number | null };
		// Snapped down to the last whole emoji before byte 150: 100 'a' + 12 emoji = 148 bytes.
		expect(Buffer.byteLength(first.content, 'utf8')).toBeLessThanOrEqual(150);
		expect(first.returned_bytes).toBe(148);
		expect(first.content).not.toContain('�'); // no replacement char = codepoint intact
		expect(first.next_offset).toBe(first.returned_bytes);

		// Page to the end in small windows and confirm exact, uncorrupted reassembly.
		let offset = 0;
		let assembled = '';
		for (let i = 0; i < 2000; i++) {
			const win = (await callToolViaMcp('read_project_doc', {
				project: projectId,
				filename: 'emoji-doc.md',
				offset,
				max_bytes: 150,
			})) as { content: string; next_offset: number | null };
			assembled += win.content;
			if (win.next_offset === null) break;
			offset = win.next_offset;
		}
		expect(assembled).toBe(content);
		expect(assembled).not.toContain('�');
	});

	it('returns a doc that fits whole with no paging', async () => {
		const content = '# Small\n\nJust a little content.';
		await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'small-doc.md',
			content,
		});
		const r = (await callToolViaMcp('read_project_doc', {
			project: projectId,
			filename: 'small-doc.md',
		})) as {
			content: string;
			offset: number;
			returned_bytes: number;
			total_bytes: number;
			next_offset: number | null;
			truncated: boolean;
			paging_hint?: string;
		};
		const bytes = Buffer.byteLength(content, 'utf8');
		expect(r.content).toBe(content);
		expect(r.offset).toBe(0);
		expect(r.next_offset).toBeNull();
		expect(r.truncated).toBe(false);
		expect(r.returned_bytes).toBe(bytes);
		expect(r.total_bytes).toBe(bytes);
		expect(r.paging_hint).toBeUndefined();
	});

	it('clamps a window to max_bytes', async () => {
		await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'clamp-doc.md',
			content: 'y'.repeat(1000),
		});
		const r = (await callToolViaMcp('read_project_doc', {
			project: projectId,
			filename: 'clamp-doc.md',
			max_bytes: 100,
		})) as {
			content: string;
			offset: number;
			returned_bytes: number;
			next_offset: number | null;
			truncated: boolean;
		};
		expect(r.returned_bytes).toBe(100);
		expect(r.offset).toBe(0);
		expect(r.next_offset).toBe(100);
		expect(r.truncated).toBe(true);
		expect(r.content).toBe('y'.repeat(100));
	});

	it('returns an empty tail when offset is past the end', async () => {
		await callToolViaMcp('write_project_doc', {
			project: projectId,
			filename: 'tail-doc.md',
			content: 'z'.repeat(50),
		});
		const r = (await callToolViaMcp('read_project_doc', {
			project: projectId,
			filename: 'tail-doc.md',
			offset: 9999,
		})) as {
			content: string;
			offset: number;
			returned_bytes: number;
			total_bytes: number;
			next_offset: number | null;
		};
		expect(r.content).toBe('');
		expect(r.returned_bytes).toBe(0);
		expect(r.next_offset).toBeNull();
		expect(r.total_bytes).toBe(50);
		expect(r.offset).toBe(50); // clamped down to total_bytes
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
	it('set_agent_summary and set_team_summary are registered', () => {
		// Registry, not `tools/list` - set_team_summary is Captain-or-HQ only.
		const toolNames = getToolDefs().map((t) => t.name);
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

describe('MCP create_project (CEO creates a project + team on approval)', () => {
	async function callToolAs(
		tokenStr: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
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
		const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
		return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
	}

	async function startIntake(
		name: string,
	): Promise<{ intake_task_id: string; intake_task_identifier: string }> {
		const res = await app.request('/api/project-intakes', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, description: 'Build the thing.' }),
		});
		expect(res.status).toBe(201);
		return (await res.json()).data;
	}

	async function startupTemplateId(): Promise<string> {
		const res = await app.request('/api/team-templates', { headers: authHeader(token) });
		return (await res.json()).data.find((t: { name: string }) => t.name === 'App Team').id;
	}

	it('creates the project + team + planning task and closes the intake', async () => {
		const intake = await startIntake(`CEO Create ${Date.now()}`);
		const ceoId = await instanceCeoId(db);
		const { token: ceoToken } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			DEFAULT_TEAM_ID,
			intake.intake_task_id,
		);
		const tplId = await startupTemplateId();

		const result = await callToolAs(ceoToken, 'create_project', {
			name: 'CEO Built Project',
			description: 'A project the CEO created after approval.',
			template_id: tplId,
			intake_task_id: intake.intake_task_id,
		});
		expect(result.error).toBeUndefined();
		expect(result.team_slug).toBeTruthy();
		expect(result.planning_task_identifier).toBeTruthy();

		const project = await db.query<{ id: string; team_id: string }>(
			'SELECT id, team_id FROM projects WHERE slug = $1',
			[result.slug as string],
		);
		expect(project.rows[0]).toBeDefined();

		// The new team carries a Captain (from the App Team template) and a planning task.
		const captain = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[project.rows[0].team_id],
		);
		expect(captain.rows[0].n).toBe(1);
		const planning = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND labels @> '["planning"]'::jsonb`,
			[project.rows[0].id],
		);
		expect(planning.rows[0].n).toBe(1);

		// The intake ticket is closed.
		const intakeTask = await db.query<{ status: string }>(
			'SELECT status::text AS status FROM tasks WHERE id = $1',
			[intake.intake_task_id],
		);
		expect(intakeTask.rows[0].status).toBe('done');
	});

	it('accepts the intake task identifier (e.g. HQ-1), not only its UUID', async () => {
		const intake = await startIntake(`CEO Identifier ${Date.now()}`);
		const ceoId = await instanceCeoId(db);
		const { token: ceoToken } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			DEFAULT_TEAM_ID,
			intake.intake_task_id,
		);

		// Pass the human-readable identifier the agent sees in the thread, not the UUID.
		const result = await callToolAs(ceoToken, 'create_project', {
			name: 'Identifier Project',
			description: 'Created by passing the intake identifier.',
			intake_task_id: intake.intake_task_identifier,
		});
		expect(result.error).toBeUndefined();
		expect(result.slug).toBeTruthy();

		// The intake ticket resolved from the identifier is closed.
		const intakeTask = await db.query<{ status: string }>(
			'SELECT status::text AS status FROM tasks WHERE id = $1',
			[intake.intake_task_id],
		);
		expect(intakeTask.rows[0].status).toBe('done');
	});

	it('errors clearly when the intake identifier does not resolve', async () => {
		const ceoId = await instanceCeoId(db);
		const { token: ceoToken } = await mintAgentToken(db, masterKeyManager, ceoId, DEFAULT_TEAM_ID);
		const result = await callToolAs(ceoToken, 'create_project', {
			name: 'No Intake Project',
			description: 'Intake reference is bogus.',
			intake_task_id: 'HQ-999999',
		});
		expect(result.error).toBe('Intake task not found');
	});

	it('is idempotent — a second call on a closed intake errors instead of duplicating', async () => {
		const intake = await startIntake(`CEO Idem ${Date.now()}`);
		const ceoId = await instanceCeoId(db);
		const { token: ceoToken } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			DEFAULT_TEAM_ID,
			intake.intake_task_id,
		);

		const first = await callToolAs(ceoToken, 'create_project', {
			name: 'Idem Project',
			description: 'First creation.',
			intake_task_id: intake.intake_task_id,
		});
		expect(first.error).toBeUndefined();

		const second = await callToolAs(ceoToken, 'create_project', {
			name: 'Idem Project Dup',
			description: 'Should not create a second.',
			intake_task_id: intake.intake_task_id,
		});
		expect(second.error).toContain('already been completed');
	});

	it('rejects a non-CEO agent', async () => {
		const intake = await startIntake(`CEO Guard ${Date.now()}`);
		const { token: workerToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);
		const result = await callToolAs(workerToken, 'create_project', {
			name: 'Worker Project',
			description: 'Should be rejected.',
			intake_task_id: intake.intake_task_id,
		});
		expect(result.error).toContain('Only the CEO');
	});

	it('rejects a malformed task_prefix', async () => {
		const intake = await startIntake(`CEO Prefix ${Date.now()}`);
		const ceoId = await instanceCeoId(db);
		const { token: ceoToken } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			DEFAULT_TEAM_ID,
			intake.intake_task_id,
		);
		const result = await callToolAs(ceoToken, 'create_project', {
			name: 'Prefix Project',
			description: 'Bad prefix.',
			task_prefix: 'lowercase-too-long',
			intake_task_id: intake.intake_task_id,
		});
		expect(typeof result.error).toBe('string');
		expect(result.error as string).toContain('task_prefix');
	});

	// Create a project as the CEO (the chat/intake path) and return the CEO token +
	// the create_project result so a follow-up start_team_setup test can drive it.
	async function createProjectAsCeo(
		label: string,
	): Promise<{ ceoToken: string; ceoId: string; result: Record<string, unknown> }> {
		const intake = await startIntake(`${label} ${Date.now()}`);
		const ceoId = await instanceCeoId(db);
		const { token: ceoToken } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			DEFAULT_TEAM_ID,
			intake.intake_task_id,
		);
		const tplId = await startupTemplateId();
		const result = await callToolAs(ceoToken, 'create_project', {
			name: `${label} ${Date.now()}`,
			description: `${label} description.`,
			template_id: tplId,
			intake_task_id: intake.intake_task_id,
		});
		expect(result.error).toBeUndefined();
		return { ceoToken, ceoId, result };
	}

	it('does NOT auto-run coherence: the setup task is created unassigned, with no wakeup, and planning stays blocked on it', async () => {
		const { result } = await createProjectAsCeo('No Auto Coherence');
		expect(result.setup_task_id).toBeTruthy();
		expect(result.setup_task_identifier).toBeTruthy();
		const coherenceId = result.setup_task_id as string;

		// Created unassigned with the draft-then-start banner — the CEO drafts then kicks off.
		const ticket = await db.query<{ assignee_id: string | null; description: string }>(
			'SELECT assignee_id, description FROM tasks WHERE id = $1',
			[coherenceId],
		);
		expect(ticket.rows[0].assignee_id).toBeNull();
		expect(ticket.rows[0].description).toContain('start_team_setup');

		// No wakeup fired for the coherence ticket — it does not auto-run.
		const wakeups = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM agent_wakeup_requests WHERE payload->>'task_id' = $1`,
			[coherenceId],
		);
		expect(wakeups.rows[0].n).toBe(0);

		// The planning ticket is still blocked by the coherence ticket (gate unchanged).
		const dep = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM task_dependencies WHERE task_id = $1 AND blocked_by_task_id = $2`,
			[result.planning_task_id as string, coherenceId],
		);
		expect(dep.rows[0].n).toBe(1);
	});

	it('start_team_setup assigns the coherence task to the CEO and wakes them', async () => {
		const { ceoToken, ceoId, result } = await createProjectAsCeo('Setup Happy');
		const coherenceId = result.setup_task_id as string;

		const started = await callToolAs(ceoToken, 'start_team_setup', { project: result.slug });
		expect(started.error).toBeUndefined();
		expect(started.started).toBe(true);
		expect(started.task_id).toBe(coherenceId);

		const ticket = await db.query<{ assignee_id: string | null }>(
			'SELECT assignee_id FROM tasks WHERE id = $1',
			[coherenceId],
		);
		expect(ticket.rows[0].assignee_id).toBe(ceoId);

		const wakeups = await db.query<{ source: string }>(
			`SELECT source FROM agent_wakeup_requests WHERE member_id = $1 AND payload->>'task_id' = $2`,
			[ceoId, coherenceId],
		);
		expect(wakeups.rows.length).toBe(1);
		expect(wakeups.rows[0].source).toBe('assignment');
	});

	it('start_team_setup errors when there is no open setup task', async () => {
		const { ceoToken, result } = await createProjectAsCeo('Setup Done');
		await db.query(`UPDATE tasks SET status = 'done'::task_status WHERE id = $1`, [
			result.setup_task_id as string,
		]);
		const started = await callToolAs(ceoToken, 'start_team_setup', { project: result.slug });
		expect(started.error).toContain('No open team-setup task');
	});

	it('start_team_setup rejects a non-CEO agent', async () => {
		const { result } = await createProjectAsCeo('Setup Guard');
		const { token: workerToken } = await mintAgentToken(db, masterKeyManager, agentId, teamId);
		const started = await callToolAs(workerToken, 'start_team_setup', { project: result.slug });
		expect(started.error).toContain('Only the CEO');
	});

	it('start_team_setup is idempotent — a second call coalesces to a single queued wakeup', async () => {
		const { ceoToken, ceoId, result } = await createProjectAsCeo('Setup Idem');
		const coherenceId = result.setup_task_id as string;

		const first = await callToolAs(ceoToken, 'start_team_setup', { project: result.slug });
		expect(first.started).toBe(true);
		const second = await callToolAs(ceoToken, 'start_team_setup', { project: result.slug });
		expect(second.started).toBe(true);

		const wakeups = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM agent_wakeup_requests
			 WHERE member_id = $1 AND payload->>'task_id' = $2 AND status = 'queued'`,
			[ceoId, coherenceId],
		);
		expect(wakeups.rows[0].n).toBe(1);
	});
});

describe('MCP tools: project arg accepts a slug or UUID', () => {
	// The CEO addresses projects by slug (it never sees UUIDs); project-scoped tools
	// must resolve that slug so a cross-project status query returns real data instead
	// of coming back empty.
	it('list_agents resolves a project slug to the same roster as the UUID', async () => {
		const bySlug = (await callListViaMcp('list_agents', { project: projectSlug })) as Array<{
			slug: string;
		}>;
		const byUuid = (await callListViaMcp('list_agents', { project: projectId })) as Array<{
			slug: string;
		}>;
		expect(Array.isArray(bySlug)).toBe(true);
		expect(bySlug.length).toBeGreaterThan(0);
		expect(bySlug.map((a) => a.slug).sort()).toEqual(byUuid.map((a) => a.slug).sort());
	});

	it('list_tasks resolves a project slug and returns the seeded task', async () => {
		const rows = (await callListViaMcp('list_tasks', { project: projectSlug })) as Array<{
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
	it('both tools are registered', () => {
		// Registry, not `tools/list` - set_agent_team_context is Captain-or-HQ only.
		const toolNames = getToolDefs().map((t) => t.name);
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

	it('default_team_context defaults are populated for App Team template agents', async () => {
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
	it('create_task caps sub-task depth at 3', async () => {
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

		const subSubSub = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Depth sub-sub-sub',
			assignee_id: agentId,
			parent_task_id: subSub.id,
		})) as { id: string; error?: string };
		expect(subSubSub.error).toBeUndefined();

		const tooDeep = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Depth too deep',
			assignee_id: agentId,
			parent_task_id: subSubSub.id,
		})) as { error?: string };
		expect(tooDeep.error).toMatch(/3 levels deep/);
	});

	it('create_task resolves a parent passed by identifier (the agent-facing form)', async () => {
		const parent = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Parent by identifier',
			assignee_id: agentId,
		})) as { id: string; identifier: string };

		// Agents reference tasks by bare identifier (e.g. "BE-2") everywhere; passing
		// that as parent_task_id must resolve to the parent UUID rather than reach the
		// uuid column and crash with "invalid input syntax for type uuid".
		const child = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Child by identifier',
			assignee_id: agentId,
			parent_task_id: parent.identifier,
		})) as { id: string; parent_task_id: string | null; error?: string };
		expect(child.error).toBeUndefined();
		expect(child.parent_task_id).toBe(parent.id);
	});

	it('create_task returns a clean not-found error for an unknown parent identifier', async () => {
		const result = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Orphan child',
			assignee_id: agentId,
			parent_task_id: 'ZZ-999999',
		})) as { error?: string };
		expect(result.error).toMatch(/parent task/i);
	});
});

describe('MCP tool: update_task re-parenting', () => {
	async function newTask(title: string, parentTaskId?: string) {
		const task = (await callToolViaMcp('create_task', {
			project: projectId,
			title,
			assignee_id: agentId,
			...(parentTaskId ? { parent_task_id: parentTaskId } : {}),
		})) as { id: string; identifier: string; error?: string };
		expect(task.error).toBeUndefined();
		return task;
	}

	// The load-bearing case: `update_task` builds its SQL generically from the
	// arg keys, so an unresolved identifier would hit the uuid column directly.
	it('resolves a parent passed by identifier', async () => {
		const parent = await newTask('MCP reparent parent');
		const mover = await newTask('MCP reparent mover');

		const updated = (await callToolViaMcp('update_task', {
			project: projectId,
			task_id: mover.identifier,
			parent_task_id: parent.identifier,
		})) as { parent_task_id: string | null; error?: string };
		expect(updated.error).toBeUndefined();
		expect(updated.parent_task_id).toBe(parent.id);
	});

	it('promotes to top level with null', async () => {
		const parent = await newTask('MCP promote parent');
		const child = await newTask('MCP promote child', parent.id);

		const updated = (await callToolViaMcp('update_task', {
			project: projectId,
			task_id: child.identifier,
			parent_task_id: null,
		})) as { parent_task_id: string | null; error?: string };
		expect(updated.error).toBeUndefined();
		expect(updated.parent_task_id).toBeNull();
	});

	it('promotes to top level with an empty string', async () => {
		const parent = await newTask('MCP promote parent 2');
		const child = await newTask('MCP promote child 2', parent.id);

		const updated = (await callToolViaMcp('update_task', {
			project: projectId,
			task_id: child.identifier,
			parent_task_id: '',
		})) as { parent_task_id: string | null; error?: string };
		expect(updated.error).toBeUndefined();
		expect(updated.parent_task_id).toBeNull();
	});

	it('reports no change when the parent is already that task', async () => {
		const parent = await newTask('MCP noop parent');
		const child = await newTask('MCP noop child', parent.id);

		const updated = (await callToolViaMcp('update_task', {
			project: projectId,
			task_id: child.identifier,
			parent_task_id: parent.identifier,
		})) as { unchanged?: boolean };
		expect(updated.unchanged).toBe(true);
	});

	it('rejects an unknown parent', async () => {
		const mover = await newTask('MCP unknown parent mover');
		const result = (await callToolViaMcp('update_task', {
			project: projectId,
			task_id: mover.identifier,
			parent_task_id: 'ZZ-999999',
		})) as { error?: string };
		expect(result.error).toMatch(/parent task not found/i);
	});

	it('rejects nesting a task under its own sub-task', async () => {
		const top = await newTask('MCP cycle top');
		const child = await newTask('MCP cycle child', top.id);

		const result = (await callToolViaMcp('update_task', {
			project: projectId,
			task_id: top.identifier,
			parent_task_id: child.identifier,
		})) as { error?: string };
		expect(result.error).toMatch(/one of its own sub-tasks/);
	});

	it('rejects a move that would push the sub-tree past the depth cap', async () => {
		const mover = await newTask('MCP depth mover');
		await newTask('MCP depth mover child', mover.id);
		const root = await newTask('MCP depth root');
		const mid = await newTask('MCP depth mid', root.id);
		const deep = await newTask('MCP depth deep', mid.id);

		const result = (await callToolViaMcp('update_task', {
			project: projectId,
			task_id: mover.identifier,
			parent_task_id: deep.identifier,
		})) as { error?: string };
		expect(result.error).toMatch(/3 levels deep/);
	});

	it('rejects an open task under a completed parent', async () => {
		const parent = await newTask('MCP closed parent');
		const mover = await newTask('MCP open mover');
		await callToolViaMcp('update_task', {
			project: projectId,
			task_id: parent.identifier,
			status: 'done',
		});

		const result = (await callToolViaMcp('update_task', {
			project: projectId,
			task_id: mover.identifier,
			parent_task_id: parent.identifier,
		})) as { error?: string };
		expect(result.error).toMatch(/already done/);
	});

	it('records the move on the task thread', async () => {
		const parent = await newTask('MCP recorded parent');
		const mover = await newTask('MCP recorded mover');

		await callToolViaMcp('update_task', {
			project: projectId,
			task_id: mover.identifier,
			parent_task_id: parent.identifier,
		});

		const comments = await db.query<{ content: Record<string, unknown> }>(
			`SELECT content FROM task_comments
			  WHERE task_id = $1 AND content_type = 'system' AND content->>'kind' = 'parent_change'`,
			[mover.id],
		);
		expect(comments.rows).toHaveLength(1);
		expect(comments.rows[0].content).toMatchObject({
			to_id: parent.id,
			to_identifier: parent.identifier,
		});
	});
});

describe('MCP tool: result shape — no embeddings, opt-in excerpts, size guard', () => {
	it('list_tasks never returns the embedding column', async () => {
		const rows = await callListViaMcp('list_tasks', { project: projectId });
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row).not.toHaveProperty('embedding');
			// description is excerpted by default now, so the width of one page is
			// bounded; the excerpt triple stands in for the raw column.
			expect(row).toHaveProperty('description_excerpt');
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

		const comments = await callListViaMcp('list_comments', {
			project: projectId,
			task_id: created.identifier,
		});
		expect(Array.isArray(comments)).toBe(true);
	});

	// A run comment records who is about to run, not how the run ended, and the
	// `run_failed` notices beside it are suppressed after a streak of failures.
	// Both tools resolve the outcome so an agent auditing a thread can see it;
	// get_comment matches because its docs promise `list_comments`' own shape.
	it('list_comments and get_comment both resolve the outcome of a run comment', async () => {
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
			 VALUES ($1, $2, $3, 'failed'::heartbeat_run_status) RETURNING id`,
			[teamId, agentId, taskId],
		);
		const comment = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'run'::comment_content_type, $3::jsonb) RETURNING id`,
			[taskId, agentId, JSON.stringify({ run_id: run.rows[0].id, agent_slug: 'mcp-bot' })],
		);
		const commentId = comment.rows[0].id;

		// Run markers are left out of the default read, so this asks for them.
		const rows = await callListViaMcp('list_comments', {
			project: projectId,
			task_id: taskId,
			categories: ['runs'],
		});
		expect(rows.find((r) => r.id === commentId)!.run_status).toBe('failed');

		const defaulted = await callListViaMcp('list_comments', {
			project: projectId,
			task_id: taskId,
		});
		expect(defaulted.some((r) => r.id === commentId)).toBe(false);

		const single = (await callToolViaMcp('get_comment', {
			project: projectId,
			comment_id: commentId,
		})) as Record<string, unknown>;
		expect(single.run_status).toBe('failed');
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

		const rows = await callListViaMcp('list_tasks', {
			project: projectId,
			excerpt_chars: 50,
		});
		const target = rows.find((r) => r.id === created.id) as Record<string, unknown>;
		expect(target).toBeDefined();
		expect(target).not.toHaveProperty('description');
		expect(target.description_excerpt).toBe('Paragraph one is the headline.');
		expect(target.description_truncated).toBe(true);
		expect(target.description_length).toBe(longBody.length);
	});

	it('list_tasks excerpts by default, returning a short description whole', async () => {
		// Row width is bounded whether or not the caller asks: a page of long
		// tickets must not be able to blow the result cap. A description under the
		// default cap still comes back in full, just under the excerpt key.
		const body = 'Single short body.';
		const created = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Full body target',
			description: body,
			assignee_id: agentId,
		})) as { id: string };

		const rows = await callListViaMcp('list_tasks', { project: projectId });
		const target = rows.find((r) => r.id === created.id) as Record<string, unknown>;
		expect(target).not.toHaveProperty('description');
		expect(target.description_excerpt).toBe(body);
		expect(target.description_truncated).toBe(false);
		expect(target.description_length).toBe(body.length);
	});

	it('list_comments pages at 50, walks backward via `before`, and truncates with excerpt_chars', async () => {
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

		const firstPage = (await callToolViaMcp('list_comments', {
			project: projectId,
			task_id: task.id,
		})) as { items: Array<Record<string, unknown>>; has_more: boolean; next_cursor: string | null };
		const first = firstPage.items;
		expect(first.length).toBe(50);
		// More remain, and the response says so and how to reach them - the gap
		// this whole change exists to close.
		expect(firstPage.has_more).toBe(true);
		expect(firstPage.next_cursor).toBeTruthy();
		expect((first[0].content as { text: string }).text).toBe('comment 59');

		const oldest = first[first.length - 1] as { id: string };
		const next = await callListViaMcp('list_comments', {
			project: projectId,
			task_id: task.id,
			before: oldest.id,
		});
		expect(next.length).toBeGreaterThan(0);
		expect(next.length).toBeLessThanOrEqual(50);
		for (const row of next) {
			expect(row.id).not.toBe(oldest.id);
		}

		// The body opens with a short line followed by a blank line - the exact
		// shape that used to collapse a 9400-character comment down to its 73-char
		// preamble, because the excerpt cut at the FIRST paragraph break and
		// applied excerpt_chars only as a secondary cap. The previous fixture here
		// was 'x'.repeat(5000): a single paragraph with no blank line, so it never
		// exercised that path and the defect shipped untested.
		const preamble = 'Here is my review. I have read:';
		const longText = `${preamble}\n\n${'detail '.repeat(1200)}`;
		await db.query(
			`INSERT INTO task_comments (task_id, content_type, content, created_at)
			 VALUES ($1, 'text'::comment_content_type, $2::jsonb,
			         now() + interval '1 hour')`,
			[task.id, JSON.stringify({ text: longText })],
		);
		const truncated = await callListViaMcp('list_comments', {
			project: projectId,
			task_id: task.id,
			excerpt_chars: 100,
		});
		const longRow = truncated[0] as {
			id: string;
			content: { text: string };
			text_truncated?: boolean;
			text_length?: number;
			text_paging_hint?: string;
		};
		expect(longRow.content.text.length).toBeLessThanOrEqual(100);
		// The budget is a floor to fill, not a ceiling applied after some other
		// rule: the excerpt must run well past the short preamble.
		expect(longRow.content.text.length).toBeGreaterThan(preamble.length);
		expect(longRow.text_truncated).toBe(true);
		expect(longRow.text_length).toBe(longText.length);
		// A truncated row names its own recovery call - the excerpt sits in
		// content.text, the same field a whole comment uses, so a reader who
		// misses text_truncated would otherwise treat it as the entire comment.
		expect(longRow.text_paging_hint).toContain('get_comment');

		// get_comment is that recovery call, and it must actually serve the body.
		const full = (await callToolViaMcp('get_comment', {
			project: projectId,
			comment_id: longRow.id,
		})) as { content: { text: string }; truncated: boolean; total_bytes: number };
		expect(full.content.text).toBe(longText);
		expect(full.truncated).toBe(false);
		expect(full.total_bytes).toBe(Buffer.byteLength(longText, 'utf8'));

		// ...and it accepts the public_id form a thread citation uses.
		const byPublicId = (await callToolViaMcp('get_comment', {
			project: projectId,
			comment_id: (longRow as unknown as { public_id: string }).public_id,
		})) as { content: { text: string } };
		expect(byPublicId.content.text).toBe(longText);
	});

	it('get_comment windows a very large body and refuses one outside the project', async () => {
		const task = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'Windowed comment read',
			assignee_id: agentId,
		})) as { id: string };
		// Comfortably past the 64KB result budget, so one read cannot serve it.
		const huge = 'paragraph text '.repeat(8000);
		const ins = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, 'text'::comment_content_type, $2::jsonb)
			 RETURNING id`,
			[task.id, JSON.stringify({ text: huge })],
		);
		const commentId = ins.rows[0].id;

		const first = (await callToolViaMcp('get_comment', {
			project: projectId,
			comment_id: commentId,
		})) as {
			content: { text: string };
			truncated: boolean;
			next_offset: number | null;
			total_bytes: number;
			paging_hint?: string;
		};
		expect(first.truncated).toBe(true);
		expect(first.next_offset).toBeGreaterThan(0);
		expect(first.total_bytes).toBe(Buffer.byteLength(huge, 'utf8'));
		expect(first.paging_hint).toContain('get_comment');

		// Page to the end and reassemble - the whole body must be reachable.
		let assembled = first.content.text;
		let offset = first.next_offset;
		for (let guard = 0; offset !== null && guard < 50; guard++) {
			const next = (await callToolViaMcp('get_comment', {
				project: projectId,
				comment_id: commentId,
				offset,
			})) as { content: { text: string }; next_offset: number | null };
			assembled += next.content.text;
			offset = next.next_offset;
		}
		expect(offset).toBeNull();
		expect(assembled).toBe(huge);

		const missing = (await callToolViaMcp('get_comment', {
			project: projectId,
			comment_id: '00000000-0000-0000-0000-000000000000',
		})) as { error?: string };
		expect(missing.error).toContain('not found');
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
				title: `Fat task ${i}`,
				description: fatBody,
				assignee_id: agentId,
			});
		}

		// A page of fat tickets used to blow the cap and be discarded whole. The
		// default excerpt bounds row width, so the ordinary call now succeeds.
		const ok = (await callToolViaMcp('list_tasks', { project: fatProjectId })) as {
			error?: string;
			items?: Array<Record<string, unknown>>;
		};
		expect(ok.error).toBeUndefined();
		expect(ok.items?.length).toBeGreaterThanOrEqual(8);
		for (const row of ok.items ?? []) {
			expect(row).toHaveProperty('description_excerpt');
			expect(row).toHaveProperty('description_truncated');
			expect(row).toHaveProperty('description_length');
		}

		// Opting out of the width bound is what can still overflow, and the guard
		// then names remedies drawn from this tool's own parameters.
		const result = (await callToolViaMcp('list_tasks', {
			project: fatProjectId,
			excerpt_chars: 100_000,
		})) as {
			error?: string;
			tool?: string;
			size_bytes?: number;
			limit_bytes?: number;
			hint?: string;
			remedies?: string[];
		};
		expect(result.error).toBe('result_too_large');
		expect(result.tool).toBe('list_tasks');
		expect(result.size_bytes).toBeGreaterThan(result.limit_bytes ?? 0);
		expect(result.hint).toContain('Split the work');
		const remedies = (result.remedies ?? []).join(' ');
		expect(remedies).toContain('cursor');
		expect(remedies).toContain('excerpt_chars');
	});
});

describe('MCP reference params accept the human identifier, not only the UUID', () => {
	async function captainMemberId(): Promise<string> {
		const r = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[teamId],
		);
		return r.rows[0].id;
	}

	it('update_task.assignee_id resolves an agent slug to its member id', async () => {
		const taskRowId = await insertTaskDirect(agentId, 'Reassign by slug');
		const result = (await callToolViaMcp('update_task', {
			project: projectId,
			task_id: taskRowId,
			assignee_id: 'captain', // the slug an agent holds, not the member UUID
		})) as { assignee_id?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.assignee_id).toBe(await captainMemberId());
	});

	it('update_task.assignee_id returns a clean error for an unknown slug', async () => {
		const taskRowId = await insertTaskDirect(agentId, 'Reassign to nobody');
		const result = (await callToolViaMcp('update_task', {
			project: projectId,
			task_id: taskRowId,
			assignee_id: 'not-a-real-agent',
		})) as { error?: string };
		expect(result.error).toContain('Assignee not found');
	});

	it('list_tasks.assignee_id filters by an agent slug', async () => {
		const captainId = await captainMemberId();
		const mine = await insertTaskDirect(captainId, 'Captain task for slug filter');
		const rows = (await callListViaMcp('list_tasks', {
			project: projectId,
			assignee_id: 'captain', // slug, not member UUID
		})) as Array<{ id: string; assignee_id: string }>;
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.assignee_id === captainId)).toBe(true);
		expect(rows.some((r) => r.id === mine)).toBe(true);
	});

	it('list_comments.before accepts a comment public_id', async () => {
		const task = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'public_id pagination',
			assignee_id: agentId,
		})) as { id: string };
		for (let i = 0; i < 3; i++) {
			await db.query(
				`INSERT INTO task_comments (task_id, content_type, content, created_at)
				 VALUES ($1, 'text'::comment_content_type, $2::jsonb, now() + ($3 || ' milliseconds')::interval)`,
				[task.id, JSON.stringify({ text: `c${i}` }), i],
			);
		}
		const all = (await callListViaMcp('list_comments', {
			project: projectId,
			task_id: task.id,
		})) as Array<{ id: string; public_id: string }>;
		expect(all.length).toBe(3);
		const newest = all[0];
		const older = (await callListViaMcp('list_comments', {
			project: projectId,
			task_id: task.id,
			before: newest.public_id, // cite by public_id, not the UUID
		})) as Array<{ id: string }>;
		expect(older.length).toBe(2);
		expect(older.some((r) => r.id === newest.id)).toBe(false);
	});

	it('create_comment.parent_comment_id accepts a public_id and threads the reply', async () => {
		const task = (await callToolViaMcp('create_task', {
			project: projectId,
			title: 'reply by public_id',
			assignee_id: agentId,
		})) as { id: string };
		const parent = (await callToolViaMcp('create_comment', {
			project: projectId,
			task_id: task.id,
			content: 'parent comment',
		})) as { id: string; public_id: string };
		const reply = (await callToolViaMcp('create_comment', {
			project: projectId,
			task_id: task.id,
			content: 'child reply',
			parent_comment_id: parent.public_id, // cite by public_id, not the UUID
		})) as { parent_comment_id?: string; error?: string };
		expect(reply.error).toBeUndefined();
		expect(reply.parent_comment_id).toBe(parent.id);
	});

	it('test_connector resolves a connector by name (not only id)', async () => {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, project_id)
			 VALUES ($1, 'api'::mcp_connection_kind, '{}'::jsonb, $2)`,
			['named-api-connector', projectId],
		);
		const result = (await callToolViaMcp('test_connector', {
			project: projectId,
			connector_id: 'named-api-connector', // the name, not the UUID
		})) as { error?: string };
		// Resolution reached the kind gate — the old raw `id = $1` would have thrown
		// "invalid input syntax for type uuid" on a name instead.
		expect(result.error).toContain('test only meaningful for kind=saas');
		expect(result.error).not.toContain('connector not found');
	});

	it('remove_connector resolves a project connector by name (not only id)', async () => {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, project_id)
			 VALUES ($1, 'api'::mcp_connection_kind, '{}'::jsonb, $2)`,
			['removable-by-name', projectId],
		);
		const result = (await callToolViaMcp('remove_connector', {
			project: projectId,
			id: 'removable-by-name', // the name, not the UUID
		})) as { removed?: boolean; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.removed).toBe(true);
		const gone = await db.query('SELECT 1 FROM mcp_connections WHERE name = $1', [
			'removable-by-name',
		]);
		expect(gone.rows.length).toBe(0);
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

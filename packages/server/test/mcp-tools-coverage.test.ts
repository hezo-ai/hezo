import { DEFAULT_TEAM_ID } from '@hezo/shared';
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
	instanceCeoId,
	mintAgentToken,
} from './helpers/app';

// Branch-coverage tests for packages/server/src/mcp/tools.ts. These drive tools
// through the real /mcp request path with an admin token (instance principal),
// agent tokens, and a non-superuser board user — hitting the validation,
// authorization, and not-found branches across the tool registry.

let app: Hono<Env>;
let db: Db;
let token: string; // superuser admin
let masterKeyManager: MasterKeyManager;

let teamId: string;
let engineerId: string;
let captainId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;

let teamBId: string;
let projectBId: string;
let projectBSlug: string;
let captainBId: string;

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

	const teamRes = await createTestTeam(db, { name: 'Coverage Co A', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Coverage Project A',
		description: 'A project.',
	});
	const pData = (await projectRes.json()).data;
	projectId = pData.id;
	projectSlug = pData.slug;

	engineerId = (
		await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'engineer'`,
			[teamId],
		)
	).rows[0].id;
	captainId = (
		await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[teamId],
		)
	).rows[0].id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Seed Task', assignee_id: engineerId }),
	});
	taskId = (await taskRes.json()).data.id;

	const teamBRes = await createTestTeam(db, { name: 'Coverage Co B', template_id: typeId });
	teamBId = (await teamBRes.json()).data.id;
	const projectBRes = await createTestProject(db, teamBId, {
		name: 'Coverage Project B',
		description: 'B project.',
	});
	const pBData = (await projectBRes.json()).data;
	projectBId = pBData.id;
	projectBSlug = pBData.slug;

	captainBId = (
		await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[teamBId],
		)
	).rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

async function call(
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
	const body = (await res.json()) as {
		result?: { content: Array<{ text: string }> };
		error?: { message: string };
	};
	// A schema-validation failure comes back not as JSON but as an MCP error string
	// ("MCP error -32602: Input validation error: ...") in the result content (or, in
	// some transports, a JSON-RPC error). Surface either as { error } so callers
	// assert on it uniformly alongside the handlers' own in-band { error } results.
	if (!body.result) return { error: body.error?.message ?? 'unknown error' };
	const text = body.result.content[0].text;
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { error: text };
	}
}

// Admin (non-agent) create_task requires an assignee; an agent caller defaults
// to self. This helper supplies one so admin-driven task seeding works.
async function makeTask(
	projectSel: string,
	title: string,
	assignee: string,
	extra: Record<string, unknown> = {},
): Promise<string> {
	const r = await admin('create_task', {
		project: projectSel,
		title,
		assignee_id: assignee,
		...extra,
	});
	return (r as { id: string }).id;
}

// Admin token is an instance principal: it must name `project` on project-scoped
// tools, and can act in any team.
const admin = (toolName: string, args: Record<string, unknown> = {}) => call(token, toolName, args);

async function agentToken(memberId: string, tId: string, tkId?: string | null): Promise<string> {
	const { token: t } = await mintAgentToken(db, masterKeyManager, memberId, tId, tkId);
	return t;
}

describe('resolveScope branches', () => {
	it('admin (instance principal) without project gets `project` is required', async () => {
		const r = await admin('list_tasks', {});
		expect(r.error).toBe('`project` is required');
	});

	it('unknown project slug returns an Unknown project error', async () => {
		const r = await admin('list_tasks', { project: 'no-such-slug-xyz' });
		expect(r.error).toContain('Unknown project');
	});

	it('blank project string falls through to `project` is required for admin', async () => {
		const r = await admin('list_tasks', { project: '   ' });
		expect(r.error).toBe('`project` is required');
	});

	it('an agent run scoped to its own project resolves with no project arg', async () => {
		const t = await agentToken(engineerId, teamId, taskId);
		const r = await call(t, 'list_tasks', {});
		expect(Array.isArray(r.items)).toBe(true);
	});

	it('an agent run is denied a different project it is not cross-project for', async () => {
		const t = await agentToken(engineerId, teamId, taskId);
		const r = await call(t, 'list_tasks', { project: projectBSlug });
		expect(r.error).toContain('Access denied');
	});
});

describe('non-superuser board user authorization', () => {
	let memberUserToken: string;

	beforeAll(async () => {
		// Create a non-superuser user who is a member of teamId (via the admin
		// adding themselves), then sign a token for them.
		const { signAdminJwt } = await import('../src/middleware/auth');
		const userRes = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Board User', false) RETURNING id",
		);
		const userId = userRes.rows[0].id;
		// Member of teamId only.
		await db.query(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'user'::member_type, 'Board User') RETURNING id`,
			[teamId],
		);
		const memberId = (
			await db.query<{ id: string }>(
				`SELECT id FROM members WHERE team_id = $1 AND display_name = 'Board User' LIMIT 1`,
				[teamId],
			)
		).rows[0].id;
		await db.query(`INSERT INTO member_users (id, user_id) VALUES ($1, $2)`, [memberId, userId]);
		memberUserToken = await signAdminJwt(masterKeyManager, userId);
	});

	it('allows a member to act in their team', async () => {
		const r = await call(memberUserToken, 'list_tasks', { project: projectSlug });
		expect(Array.isArray(r.items)).toBe(true);
	});

	it('denies a non-member from acting in a team they are not in', async () => {
		const r = await call(memberUserToken, 'list_tasks', { project: projectBSlug });
		expect(r.error).toContain('not a member of this project');
	});

	it('list_teams returns only the board user’s teams', async () => {
		const r = (
			(await call(memberUserToken, 'list_teams', {})) as unknown as { items: Array<{ id: string }> }
		).items;
		expect(r.map((t) => t.id)).toContain(teamId);
		expect(r.map((t) => t.id)).not.toContain(teamBId);
	});

	it('list_projects returns only the board user’s projects', async () => {
		const r = (
			(await call(memberUserToken, 'list_projects', {})) as unknown as {
				items: Array<{ id: string }>;
			}
		).items;
		expect(r.map((p) => p.id)).toContain(projectId);
		expect(r.map((p) => p.id)).not.toContain(projectBId);
	});
});

describe('create_team superuser gate', () => {
	it('superuser admin can create a team', async () => {
		const r = await admin('create_team', { name: 'Brand New Coverage Team' });
		expect(r.error).toBeUndefined();
		expect(r.slug).toBe('brand-new-coverage-team');
	});

	it('an agent (non-admin) is denied', async () => {
		const t = await agentToken(captainId, teamId);
		const r = await call(t, 'create_team', { name: 'Should Fail' });
		expect(r.error).toContain('superuser required');
	});
});

describe('resolveTaskScope branches', () => {
	it('non-existent task identifier errors', async () => {
		const r = await admin('get_task', { project: projectSlug, task_id: 'ZZ-9999' });
		expect(r.error).toContain('Task not found');
	});

	it('a task from another project is not found in this project', async () => {
		// Seed a task in project B, then ask for it scoped to project A.
		const otherTaskId = await makeTask(projectBSlug, 'B task', captainBId);
		const r = await admin('get_task', {
			project: projectSlug,
			task_id: otherTaskId,
		});
		expect(r.error).toContain('Task not found in project');
	});

	it('get_task returns blockers and dependents arrays', async () => {
		const r = (await admin('get_task', { project: projectSlug, task_id: taskId })) as {
			blockers: unknown[];
			dependents: unknown[];
		};
		expect(Array.isArray(r.blockers)).toBe(true);
		expect(Array.isArray(r.dependents)).toBe(true);
	});
});

describe('list_tasks filter branches', () => {
	it('filters by status', async () => {
		const r = (await admin('list_tasks', {
			project: projectSlug,
			status: 'backlog,in_progress',
		})) as unknown as { items: Array<Record<string, unknown>> };
		expect(Array.isArray(r.items)).toBe(true);
	});

	it('assignee_slug that does not resolve returns an empty page', async () => {
		const r = (await admin('list_tasks', {
			project: projectSlug,
			assignee_slug: 'no-such-agent',
		})) as unknown as { items: unknown[]; has_more: boolean };
		expect(r.items).toEqual([]);
		expect(r.has_more).toBe(false);
	});

	it('assignee_slug resolves to a real agent', async () => {
		const r = (
			(await admin('list_tasks', {
				project: projectSlug,
				assignee_slug: 'engineer',
			})) as unknown as { items: Array<{ title: string }> }
		).items;
		expect(r.map((t) => t.title)).toContain('Seed Task');
	});

	it('excerpt_chars truncates description and rules fields', async () => {
		await makeTask(projectSlug, 'Long desc task', engineerId, {
			description: 'A'.repeat(500),
		});
		const r = (
			(await admin('list_tasks', {
				project: projectSlug,
				excerpt_chars: 50,
			})) as unknown as { items: Array<Record<string, unknown>> }
		).items;
		const row = r.find((t) => t.title === 'Long desc task');
		expect(row).toBeDefined();
		expect(row).toHaveProperty('description_excerpt');
		expect(row).toHaveProperty('description_truncated');
		expect(row).not.toHaveProperty('description');
	});
});

describe('create_task error branches', () => {
	it('CreateTaskError (bad assignee) surfaces as an error result', async () => {
		const r = await admin('create_task', {
			project: projectSlug,
			title: 'Bad parent',
			assignee_id: engineerId,
			parent_task_id: 'NOPE-1',
		});
		expect(typeof r.error).toBe('string');
	});
});

describe('update_task branches', () => {
	it('no updatable fields returns { unchanged: true }', async () => {
		const r = await admin('update_task', { project: projectSlug, task_id: taskId });
		expect(r.unchanged).toBe(true);
	});

	it('runtime_type empty string clears the override (set to null)', async () => {
		const createdId = await makeTask(projectSlug, 'Runtime target', engineerId);
		await admin('update_task', {
			project: projectSlug,
			task_id: createdId,
			runtime_type: 'codex',
		});
		const r = await admin('update_task', {
			project: projectSlug,
			task_id: createdId,
			runtime_type: '',
		});
		expect(r.error).toBeUndefined();
		const row = await db.query<{ runtime_type: string | null }>(
			'SELECT runtime_type FROM tasks WHERE id = $1',
			[createdId],
		);
		expect(row.rows[0].runtime_type).toBeNull();
	});

	// Renames and description edits made over MCP record the same thread entries a
	// PATCH from the web UI does, so an agent's edit is not invisible.
	async function systemKinds(taskIdent: string, kind: string) {
		const r = await db.query<{ content: { text?: string; to?: string; to_preview?: string } }>(
			`SELECT content FROM task_comments
			  WHERE task_id = $1 AND content_type = 'system' AND content->>'kind' = $2
			  ORDER BY created_at ASC, id ASC`,
			[taskIdent, kind],
		);
		return r.rows;
	}

	it('a title change records a title_change comment and trims the new title', async () => {
		const createdId = await makeTask(projectSlug, 'Before MCP rename', engineerId);
		const r = await admin('update_task', {
			project: projectSlug,
			task_id: createdId,
			title: '  After MCP rename  ',
		});
		expect(r.error).toBeUndefined();

		const row = await db.query<{ title: string }>('SELECT title FROM tasks WHERE id = $1', [
			createdId,
		]);
		expect(row.rows[0].title).toBe('After MCP rename');

		const events = await systemKinds(createdId, 'title_change');
		expect(events.length).toBe(1);
		expect(events[0].content.to).toBe('After MCP rename');
		expect(events[0].content.text).toContain('Before MCP rename');
	});

	it('a whitespace-only title edit records nothing', async () => {
		const createdId = await makeTask(projectSlug, 'Stable MCP title', engineerId);
		const r = await admin('update_task', {
			project: projectSlug,
			task_id: createdId,
			title: '  Stable MCP title  ',
		});
		expect(r.error).toBeUndefined();
		expect(await systemKinds(createdId, 'title_change')).toHaveLength(0);
	});

	it('a description change records a description_change comment', async () => {
		const createdId = await makeTask(projectSlug, 'MCP description', engineerId, {
			description: 'The original body.',
		});
		const r = await admin('update_task', {
			project: projectSlug,
			task_id: createdId,
			description: 'The rewritten body.',
		});
		expect(r.error).toBeUndefined();

		const events = await systemKinds(createdId, 'description_change');
		expect(events.length).toBe(1);
		expect(events[0].content.text).toContain('updated the description');
		expect(events[0].content.to_preview).toBe('The rewritten body.');
	});

	it('an unchanged description records nothing', async () => {
		const createdId = await makeTask(projectSlug, 'MCP same description', engineerId, {
			description: 'Unchanged body.',
		});
		const r = await admin('update_task', {
			project: projectSlug,
			task_id: createdId,
			description: 'Unchanged body.',
		});
		expect(r.error).toBeUndefined();
		expect(await systemKinds(createdId, 'description_change')).toHaveLength(0);
	});

	it('agent reassigning to a non-subordinate is rejected by the hierarchy check', async () => {
		const createdId = await makeTask(projectSlug, 'Hierarchy target', engineerId);
		const engToken = await agentToken(engineerId, teamId);
		const r = await call(engToken, 'update_task', {
			project: projectSlug,
			task_id: createdId,
			assignee_id: captainId,
		});
		expect(typeof r.error).toBe('string');
	});
});

describe('add_task_blocker / remove_task_blocker branches', () => {
	let aId: string;
	let bId: string;

	beforeAll(async () => {
		aId = await makeTask(projectSlug, 'Blocker A', engineerId);
		bId = await makeTask(projectSlug, 'Blocker B', engineerId);
	});

	it('blocking task not found errors', async () => {
		const r = await admin('add_task_blocker', {
			project: projectSlug,
			task_id: aId,
			blocked_by_task_id: 'NOPE-123',
		});
		expect(r.error).toContain('Blocking task not found');
	});

	it('a task cannot block itself', async () => {
		const r = await admin('add_task_blocker', {
			project: projectSlug,
			task_id: aId,
			blocked_by_task_id: aId,
		});
		expect(r.error).toContain('cannot block itself');
	});

	it('adds a blocker, then a duplicate errors', async () => {
		const r = await admin('add_task_blocker', {
			project: projectSlug,
			task_id: aId,
			blocked_by_task_id: bId,
		});
		expect(r.error).toBeUndefined();
		const dup = await admin('add_task_blocker', {
			project: projectSlug,
			task_id: aId,
			blocked_by_task_id: bId,
		});
		expect(dup.error).toContain('already exists');
	});

	it('cycle is rejected', async () => {
		// a is blocked by b. Now try b blocked by a → cycle.
		const r = await admin('add_task_blocker', {
			project: projectSlug,
			task_id: bId,
			blocked_by_task_id: aId,
		});
		expect(r.error).toContain('cycle');
	});

	it('removing a non-existent dependency errors', async () => {
		const r = await admin('remove_task_blocker', {
			project: projectSlug,
			task_id: bId,
			blocked_by_task_id: aId,
		});
		expect(r.error).toContain('Dependency not found');
	});

	it('remove_task_blocker with unknown blocker id errors', async () => {
		const r = await admin('remove_task_blocker', {
			project: projectSlug,
			task_id: aId,
			blocked_by_task_id: 'NOPE-9',
		});
		expect(r.error).toContain('Blocking task not found');
	});

	it('removes an existing dependency', async () => {
		const r = await admin('remove_task_blocker', {
			project: projectSlug,
			task_id: aId,
			blocked_by_task_id: bId,
		});
		expect(r.removed).toBe(true);
	});
});

describe('update_goal_progress / update_project_progress run gates', () => {
	it('update_goal_progress requires an agent run', async () => {
		const r = await admin('update_goal_progress', {
			project: projectSlug,
			goal_id: '00000000-0000-0000-0000-000000000000',
			progress_percent: 50,
			health: 'on_track',
			status_blurb: 'fine',
		});
		expect(r.error).toContain('within an agent run');
	});

	it('update_goal_progress: goal not found in project', async () => {
		const t = await agentToken(captainId, teamId);
		const r = await call(t, 'update_goal_progress', {
			project: projectSlug,
			goal_id: '00000000-0000-0000-0000-000000000000',
			progress_percent: 50,
			health: 'on_track',
			status_blurb: 'fine',
		});
		expect(r.error).toContain('Goal not found');
	});

	it('update_project_progress requires an agent run', async () => {
		const r = await admin('update_project_progress', {
			project: projectSlug,
			summary: 'x',
		});
		expect(r.error).toContain('within an agent run');
	});
});

describe('hire-proposal tools authorization', () => {
	it('update_hire_proposal only callable by agents', async () => {
		const r = await admin('update_hire_proposal', { approval_id: 'x', title: 'y' });
		expect(r.error).toContain('only callable by agents');
	});

	it('update_hire_proposal rejects a non-Captain agent', async () => {
		const t = await agentToken(engineerId, teamId);
		const r = await call(t, 'update_hire_proposal', { approval_id: 'x', title: 'y' });
		expect(r.error).toContain('Only the Captain');
	});

	it('update_hire_proposal: approval not found', async () => {
		const t = await agentToken(captainId, teamId);
		const r = await call(t, 'update_hire_proposal', {
			approval_id: '00000000-0000-0000-0000-000000000000',
			title: 'y',
		});
		expect(r.error).toContain('Approval not found');
	});

	it('update_hire_proposal: wrong approval type errors', async () => {
		const ap = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload)
			 VALUES ($1, 'strategy'::approval_type, '{}'::jsonb) RETURNING id`,
			[teamId],
		);
		const t = await agentToken(captainId, teamId);
		const r = await call(t, 'update_hire_proposal', {
			approval_id: ap.rows[0].id,
			title: 'y',
		});
		expect(r.error).toContain('not a hire request');
	});

	it('create_hire_proposal only callable by agents', async () => {
		const r = await admin('create_hire_proposal', { project: projectSlug, title: 'Role' });
		expect(r.error).toContain('only callable by agents');
	});

	it('create_hire_proposal rejects a non-Captain/CEO agent', async () => {
		const t = await agentToken(engineerId, teamId);
		const r = await call(t, 'create_hire_proposal', { project: projectSlug, title: 'Role' });
		expect(r.error).toContain('Only the Captain or CEO');
	});

	it('create_hire_proposal: task_id not on team errors', async () => {
		const t = await agentToken(captainId, teamId);
		const r = await call(t, 'create_hire_proposal', {
			project: projectSlug,
			title: 'Role',
			task_id: 'NOPE-1',
		});
		expect(r.error).toContain('task_id not found on this team');
	});
});

describe('create_project / start_team_setup authorization', () => {
	it('create_project only callable by agents', async () => {
		const r = await admin('create_project', { name: 'X', description: 'Y' });
		expect(r.error).toContain('only callable by agents');
	});

	it('create_project rejects a non-CEO agent', async () => {
		const t = await agentToken(captainId, teamId);
		const r = await call(t, 'create_project', { name: 'X', description: 'Y' });
		expect(r.error).toContain('Only the CEO');
	});

	it('create_project: missing name', async () => {
		const ceoId = await instanceCeoId(db);
		const t = await agentToken(ceoId, DEFAULT_TEAM_ID);
		const r = await call(t, 'create_project', { name: '   ', description: 'Y' });
		// Now enforced by the schema (`.trim().min(1)`); the SDK rejects it before the
		// handler with a JSON-RPC validation error carrying the field message.
		expect(r.error).toContain('name is required');
	});

	it('create_project: missing description', async () => {
		const ceoId = await instanceCeoId(db);
		const t = await agentToken(ceoId, DEFAULT_TEAM_ID);
		const r = await call(t, 'create_project', { name: 'Has Name', description: '  ' });
		expect(r.error).toContain('description is required');
	});

	it('start_team_setup only callable by agents', async () => {
		const r = await admin('start_team_setup', { project: projectSlug });
		expect(r.error).toContain('only callable by agents');
	});

	it('start_team_setup rejects a non-CEO agent', async () => {
		const t = await agentToken(captainId, teamId);
		const r = await call(t, 'start_team_setup', { project: projectSlug });
		expect(r.error).toContain('Only the CEO');
	});
});

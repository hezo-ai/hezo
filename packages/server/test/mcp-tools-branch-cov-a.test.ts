import { DEFAULT_TEAM_ID, TaskStatus } from '@hezo/shared';
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

// Branch-coverage tests for packages/server/src/mcp/tools.ts (part A):
// scope/authorization branches, task/comment tools, advisory warnings,
// credentials, chat memory, and cost/search read tools.

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
let taskIdentifier: string;

let teamBId: string;
let projectBSlug: string;

let apiKey: string;
let memberUserToken: string; // non-superuser board user, member of team A only

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Branch Cov A', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Branch Project A' });
	const pData = (await projectRes.json()).data;
	projectId = pData.id;
	projectSlug = pData.slug;

	const agentRow = async (slug: string) =>
		(
			await db.query<{ id: string }>(
				`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE m.team_id = $1 AND ma.slug = $2`,
				[teamId, slug],
			)
		).rows[0].id;
	engineerId = await agentRow('engineer');
	captainId = await agentRow('captain');

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Seed Task', assignee_id: engineerId }),
	});
	const tData = (await taskRes.json()).data;
	taskId = tData.id;
	taskIdentifier = tData.identifier;

	const teamBRes = await createTestTeam(db, { name: 'Branch Cov B', template_id: typeId });
	teamBId = (await teamBRes.json()).data.id;
	const projectBRes = await createTestProject(db, teamBId, { name: 'Branch Project B' });
	projectBSlug = (await projectBRes.json()).data.slug;

	// Mint an approved instance API key.
	const keyRes = await app.request('/api/api-keys', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Branch Cov Key' }),
	});
	apiKey = (await keyRes.json()).data.key;

	// A non-superuser board user who is a member of team A only.
	const { signAdminJwt } = await import('../src/middleware/auth');
	const userRes = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Board A', false) RETURNING id",
	);
	const memberRes = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'user'::member_type, 'Board A') RETURNING id`,
		[teamId],
	);
	await db.query('INSERT INTO member_users (id, user_id) VALUES ($1, $2)', [
		memberRes.rows[0].id,
		userRes.rows[0].id,
	]);
	memberUserToken = await signAdminJwt(masterKeyManager, userRes.rows[0].id);
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
	if (!body.result) return { error: body.error?.message ?? 'unknown error' };
	const text = body.result.content[0].text;
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { error: text };
	}
}

const admin = (toolName: string, args: Record<string, unknown> = {}) => call(token, toolName, args);
const viaKey = (toolName: string, args: Record<string, unknown> = {}) =>
	call(apiKey, toolName, args);

async function agentToken(memberId: string, tId: string, tkId?: string | null): Promise<string> {
	const { token: t } = await mintAgentToken(db, masterKeyManager, memberId, tId, tkId);
	return t;
}

async function makeTask(title: string, assignee: string = engineerId): Promise<string> {
	const r = await admin('create_task', {
		project: projectSlug,
		title,
		assignee_id: assignee,
	});
	expect(r.error).toBeUndefined();
	return r.id as string;
}

describe('API key principal (instance-wide)', () => {
	it('list_teams returns every team in the instance', async () => {
		const r = (await viaKey('list_teams')) as unknown as Array<{ id: string }>;
		const ids = r.map((t) => t.id);
		expect(ids).toContain(teamId);
		expect(ids).toContain(teamBId);
		expect(ids).toContain(DEFAULT_TEAM_ID);
	});

	it('list_projects returns every project (instance-wide branch)', async () => {
		const r = (await viaKey('list_projects')) as unknown as Array<{ slug: string }>;
		const slugs = r.map((p) => p.slug);
		expect(slugs).toContain(projectSlug);
		expect(slugs).toContain(projectBSlug);
	});

	it('list_projects applies excerpt_chars', async () => {
		const r = (await viaKey('list_projects', { excerpt_chars: 5 })) as unknown as Array<
			Record<string, unknown>
		>;
		expect(r.length).toBeGreaterThan(0);
		expect(r[0]).toHaveProperty('description_excerpt');
		expect(r[0]).not.toHaveProperty('description');
	});

	it('list_tasks works for any project via authorizeScope ApiKey branch', async () => {
		const r = await viaKey('list_tasks', { project: projectBSlug });
		expect(Array.isArray(r)).toBe(true);
	});

	it('still requires `project` on project-scoped tools', async () => {
		const r = await viaKey('list_tasks', {});
		expect(r.error).toBe('`project` is required');
	});
});

describe('non-superuser board user branches', () => {
	it('list_teams returns only their teams (member join branch)', async () => {
		const r = (await call(memberUserToken, 'list_teams', {})) as unknown as Array<{ id: string }>;
		const ids = r.map((t) => t.id);
		expect(ids).toContain(teamId);
		expect(ids).not.toContain(teamBId);
	});

	it('list_projects returns only their projects (admin non-superuser branch)', async () => {
		const r = (await call(memberUserToken, 'list_projects', {})) as unknown as Array<{
			slug: string;
		}>;
		const slugs = r.map((p) => p.slug);
		expect(slugs).toContain(projectSlug);
		expect(slugs).not.toContain(projectBSlug);
	});

	it('is denied on a project whose team they are not in', async () => {
		const r = await call(memberUserToken, 'list_tasks', { project: projectBSlug });
		expect(r.error).toContain('not a member of this project');
	});

	it('may resolve an approval in their own team (authorizeTeam member branch)', async () => {
		const at = await agentToken(engineerId, teamId, taskId);
		const proposed = await call(at, 'propose_skill', {
			skill_name: 'Member Resolved',
			skill_slug: 'member-resolved',
			content: '# Member\n\nBody.',
			reason: 'coverage',
		});
		const r = (await call(memberUserToken, 'resolve_approval', {
			approval_id: proposed.approval_id,
			status: 'denied',
			resolution_note: 'no thanks',
		})) as Record<string, unknown>;
		expect(r.status).toBe('denied');
	});
});

describe('list_projects for an ordinary agent', () => {
	it('returns only the run project (agent scope branch)', async () => {
		const at = await agentToken(engineerId, teamId, taskId);
		const r = (await call(at, 'list_projects', {})) as unknown as Array<{ slug: string }>;
		expect(r.map((p) => p.slug)).toEqual([projectSlug]);
	});
});

describe('list_tasks filters', () => {
	it('assignee_slug resolves an agent on the team', async () => {
		const r = (await admin('list_tasks', {
			project: projectSlug,
			assignee_slug: 'engineer',
		})) as unknown as Array<{ id: string }>;
		expect(r.map((t) => t.id)).toContain(taskId);
	});

	it('unknown assignee_slug returns an empty list', async () => {
		const r = (await admin('list_tasks', {
			project: projectSlug,
			assignee_slug: 'nobody-here',
		})) as unknown as unknown[];
		expect(r).toEqual([]);
	});

	it('excerpt_chars truncates descriptions', async () => {
		await admin('update_task', {
			project: projectSlug,
			task_id: taskId,
			description: 'A long description paragraph that will surely be truncated by excerpting.',
		});
		const r = (await admin('list_tasks', {
			project: projectSlug,
			excerpt_chars: 10,
		})) as unknown as Array<Record<string, unknown>>;
		const row = r.find((t) => t.id === taskId);
		expect(row).toBeDefined();
		expect(row).toHaveProperty('description_excerpt');
	});
});

describe('task dependencies', () => {
	it('get_task returns blockers and dependents populated', async () => {
		const blocker = await makeTask('Upstream blocker');
		const add = await admin('add_task_blocker', {
			project: projectSlug,
			task_id: taskId,
			blocked_by_task_id: blocker,
		});
		expect(add.error).toBeUndefined();

		const dup = await admin('add_task_blocker', {
			project: projectSlug,
			task_id: taskId,
			blocked_by_task_id: blocker,
		});
		expect(dup.error).toBe('Dependency already exists');

		const t = (await admin('get_task', { project: projectSlug, task_id: taskId })) as {
			blockers: Array<{ id: string }>;
			dependents: Array<{ id: string }>;
		};
		expect(t.blockers.map((b) => b.id)).toContain(blocker);

		const up = (await admin('get_task', { project: projectSlug, task_id: blocker })) as {
			dependents: Array<{ id: string }>;
		};
		expect(up.dependents.map((d) => d.id)).toContain(taskId);

		const rm = await admin('remove_task_blocker', {
			project: projectSlug,
			task_id: taskId,
			blocked_by_task_id: blocker,
		});
		expect(rm.removed).toBe(true);
	});
});

describe('update_task branches', () => {
	it('sets priority via the priority cast branch', async () => {
		const r = await admin('update_task', {
			project: projectSlug,
			task_id: taskId,
			priority: 'high',
		});
		expect(r.priority).toBe('high');
	});

	it('reassignment to an agent fires the wakeup branch', async () => {
		const t = await makeTask('Reassign target', engineerId);
		const r = await admin('update_task', {
			project: projectSlug,
			task_id: t,
			assignee_id: captainId,
		});
		expect(r.assignee_id).toBe(captainId);
	});

	it('agents cannot re-open a terminal task', async () => {
		const t = await makeTask('Terminal task');
		const done = await admin('update_task', {
			project: projectSlug,
			task_id: t,
			status: TaskStatus.Done,
		});
		expect(done.status).toBe(TaskStatus.Done);

		// Scope the run to the terminal task itself so assertRunTaskScope passes
		// and the terminal re-open gate is the branch that fires.
		const at = await agentToken(engineerId, teamId, t);
		const r = await call(at, 'update_task', {
			project: projectSlug,
			task_id: t,
			status: TaskStatus.InProgress,
		});
		expect(r.error).toBe('Only the admin can re-open a completed task');
	});
});

describe('create_tasks batch', () => {
	it('creates a batch as an agent with per-item backtick warnings', async () => {
		const at = await agentToken(captainId, teamId, taskId);
		const r = (await call(at, 'create_tasks', {
			items: [
				{
					title: 'Batch one',
					assignee_slug: 'captain',
					description: `See \`${taskIdentifier}\` for context.`,
				},
				{ title: 'Batch two', assignee_slug: 'captain' },
			],
		})) as unknown as Array<Record<string, unknown>>;
		expect(r).toHaveLength(2);
		expect(r[0].ok).toBe(true);
		expect(r[1].ok).toBe(true);
		const first = r[0].task as Record<string, unknown>;
		expect(String(first.warning)).toContain('backticks');
	});
});

describe('comment advisory warnings', () => {
	it('warns when a teammate is addressed by bold name instead of a mention', async () => {
		const at = await agentToken(captainId, teamId, taskId);
		const r = await call(at, 'create_comment', {
			task_id: taskId,
			content: 'Please **engineer** take a look at this one.',
		});
		expect(r.id).toBeDefined();
		expect(String(r.warning)).toContain('notifies no one');
	});

	it('warns when existing references are wrapped in backticks', async () => {
		// Seed a project doc, a skill, and an asset so every branch resolves.
		const doc = await admin('write_project_doc', {
			project: projectSlug,
			filename: 'notes.md',
			content: '# Notes\n\nSome notes.',
		});
		expect(doc.error).toBeUndefined();
		const skill = await admin('create_skill', {
			project: projectSlug,
			name: 'Sops',
			slug: 'sops.md',
			content: '# Sops skill\n\nHow to operate.',
		});
		expect(skill.error).toBeUndefined();
		const asset = await admin('write_project_asset', {
			project: projectSlug,
			filename: 'data.txt',
			content: 'hello',
		});
		expect(asset.error).toBeUndefined();

		// An extension-less filename has no content type and is rejected.
		const noExt = await admin('write_project_asset', {
			project: projectSlug,
			filename: 'noextension',
			content: 'x',
		});
		expect(String(noExt.error)).toContain('Unsupported asset type');

		const at = await agentToken(captainId, teamId, taskId);
		const r = await call(at, 'create_comment', {
			task_id: taskId,
			content:
				`Check \`@engineer\` plus \`${taskIdentifier}\` and \`notes.md\` ` +
				'and `sops.md` and `assets/data.txt` please.',
		});
		expect(r.id).toBeDefined();
		const warning = String(r.warning);
		expect(warning).toContain('inert code');
		expect(warning).toContain('@engineer');
		expect(warning).toContain('assets/data.txt');
		expect(warning).toContain('@@<slug>');
	});

	it('warns when an active mention lands on a terminal task', async () => {
		const t = await makeTask('Closed with ask');
		await admin('update_task', { project: projectSlug, task_id: t, status: TaskStatus.Done });
		const at = await agentToken(captainId, teamId, taskId);
		const r = await call(at, 'create_comment', {
			task_id: t,
			content: '@engineer can you confirm this is right?',
		});
		expect(r.id).toBeDefined();
		expect(String(r.warning)).toContain('terminal');
	});
});

describe('update_comment', () => {
	it('is rejected for non-agent callers', async () => {
		const r = await admin('update_comment', {
			project: projectSlug,
			task_id: taskId,
			comment_id: crypto.randomUUID(),
			content: 'x',
		});
		expect(r.error).toBe('Only an agent run can edit a comment');
	});

	it('errors when the comment does not exist on the task', async () => {
		const at = await agentToken(engineerId, teamId, taskId);
		const r = await call(at, 'update_comment', {
			task_id: taskId,
			comment_id: crypto.randomUUID(),
			content: 'x',
		});
		expect(r.error).toBe('Comment not found on this task');
	});

	it('only allows editing comments authored during the current run', async () => {
		const first = await agentToken(engineerId, teamId, taskId);
		const created = await call(first, 'create_comment', {
			task_id: taskId,
			content: 'Original text from run one.',
		});
		expect(created.id).toBeDefined();

		// A different (fresh) run may not edit it.
		const second = await agentToken(engineerId, teamId, taskId);
		const denied = await call(second, 'update_comment', {
			task_id: taskId,
			comment_id: created.id,
			content: 'rewrite',
		});
		expect(denied.error).toBe('You can only edit a comment you posted during this run');

		// The original run can, and edit-time warnings fire for added references.
		const edited = await call(first, 'update_comment', {
			task_id: taskId,
			comment_id: created.id,
			content: `Fixed text, see \`${taskIdentifier}\`.`,
		});
		expect(edited.id).toBe(created.id);
		expect(String(edited.warning)).toContain('backticks');
		const row = await db.query<{ content: Record<string, unknown> }>(
			'SELECT content FROM task_comments WHERE id = $1',
			[created.id],
		);
		expect(row.rows[0].content.text).toContain('Fixed text');
	});

	it('rejects editing a non-text comment', async () => {
		const { token: at, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			engineerId,
			teamId,
			taskId,
		);
		const cred = await call(at, 'request_credential', {
			task_id: taskId,
			name: 'NOEDIT_KEY',
			kind: 'other',
			instructions: 'paste it',
		});
		expect(cred.comment_id).toBeDefined();
		// A credential_request comment never records a run id; attribute it to
		// this run so the content-type gate is the branch under test.
		await db.query('UPDATE task_comments SET created_by_run_id = $1 WHERE id = $2', [
			runId,
			cred.comment_id,
		]);
		const r = await call(at, 'update_comment', {
			task_id: taskId,
			comment_id: cred.comment_id,
			content: 'x',
		});
		expect(r.error).toBe('Only text comments can be edited');
	});
});

describe('request_credential', () => {
	it('rejects HTTP-auth kinds without allowed_hosts', async () => {
		const at = await agentToken(engineerId, teamId, taskId);
		const r = await call(at, 'request_credential', {
			task_id: taskId,
			name: 'NETLIFY_TOKEN',
			kind: 'api_key',
			instructions: 'get a token',
		});
		expect(String(r.error)).toContain('must declare allowed_hosts');
	});

	it('creates a pending request and reuses it on a duplicate call', async () => {
		const at = await agentToken(engineerId, teamId, taskId);
		const first = await call(at, 'request_credential', {
			task_id: taskId,
			name: 'NETLIFY_TOKEN',
			kind: 'api_key',
			instructions: 'get a token',
			allowed_hosts: ['api.netlify.com'],
		});
		expect(first.placeholder).toBe('__HEZO_SECRET_NETLIFY_TOKEN__');
		expect(first.status).toBe('pending');
		expect(first.reused).toBe(false);

		const again = await call(at, 'request_credential', {
			task_id: taskId,
			name: 'NETLIFY_TOKEN',
			kind: 'api_key',
			instructions: 'get a token',
			allowed_hosts: ['api.netlify.com'],
		});
		expect(again.reused).toBe(true);
		expect(again.comment_id).toBe(first.comment_id);
	});

	it('confirmation-style requests need no allowed_hosts', async () => {
		const at = await agentToken(engineerId, teamId, taskId);
		const r = await call(at, 'request_credential', {
			task_id: taskId,
			name: 'DEPLOY_CONFIRM',
			kind: 'api_key',
			instructions: 'confirm the deploy key was added',
			confirmation_text: 'Did you add the key?',
		});
		expect(r.status).toBe('pending');
		expect(r.reused).toBe(false);
	});
});

describe('reactions', () => {
	it('adds and removes a reaction on a comment', async () => {
		const at = await agentToken(engineerId, teamId, taskId);
		const c = await call(at, 'create_comment', { task_id: taskId, content: 'react to me' });
		const add = await call(at, 'add_reaction', {
			task_id: taskId,
			comment_id: c.id,
			kind: 'ack',
		});
		expect(add.error).toBeUndefined();
		const rm = await call(at, 'remove_reaction', {
			task_id: taskId,
			comment_id: c.id,
			kind: 'ack',
		});
		expect(rm.error).toBeUndefined();
	});
});

describe('list_comments', () => {
	it('paginates with before and truncates via excerpt_chars', async () => {
		const at = await agentToken(engineerId, teamId, taskId);
		const c1 = await call(at, 'create_comment', {
			task_id: taskId,
			content: 'first long comment body for excerpting purposes',
		});
		const c2 = await call(at, 'create_comment', { task_id: taskId, content: 'second' });
		const rows = (await call(at, 'list_comments', {
			task_id: taskId,
			before: c2.id,
			excerpt_chars: 10,
		})) as unknown as Array<Record<string, unknown>>;
		expect(rows.map((r) => r.id)).toContain(c1.id);
		expect(rows.map((r) => r.id)).not.toContain(c2.id);
	});
});

describe('report_no_work / update_chat_memory / progress', () => {
	it('report_no_work records the flag on the run row', async () => {
		const { token: at, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			engineerId,
			teamId,
			taskId,
		);
		const r = await call(at, 'report_no_work', { reason: 'Nothing actionable this run.' });
		expect(r.ok).toBe(true);
		const row = await db.query<{ reported_no_work: boolean; no_work_reason: string }>(
			'SELECT reported_no_work, no_work_reason FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(row.rows[0].reported_no_work).toBe(true);
		expect(row.rows[0].no_work_reason).toBe('Nothing actionable this run.');
	});

	it('report_no_work is agent-run-only', async () => {
		const r = await admin('report_no_work', { reason: 'nope' });
		expect(r.error).toBe('report_no_work is only available within an agent run');
	});

	it('update_chat_memory rejects non-agent callers and writes for agents', async () => {
		const denied = await admin('update_chat_memory', { content: '# memory' });
		expect(String(denied.error)).toContain('update_chat_memory');

		const at = await agentToken(captainId, teamId);
		const r = await call(at, 'update_chat_memory', { content: '# memory\n\nremember this' });
		expect(r.written).toBe(true);
		const row = await db.query<{ content: string }>(
			'SELECT content FROM chat_memories WHERE member_id = $1',
			[captainId],
		);
		expect(row.rows[0].content).toContain('remember this');
	});

	it('update_project_progress requires an agent run and rejects the HQ project', async () => {
		const denied = await admin('update_project_progress', {
			project: projectSlug,
			summary: 'x',
		});
		expect(denied.error).toBe(
			'update_project_progress can only be called from within an agent run',
		);

		// Captain in its own project succeeds.
		const at = await agentToken(captainId, teamId, taskId);
		const ok = await call(at, 'update_project_progress', {
			summary: '**On track.** Everything is fine.',
		});
		expect(ok.error).toBeUndefined();

		// The HQ project has no progress summary — ProjectProgressError branch.
		const hq = await db.query<{ slug: string }>(
			'SELECT slug FROM projects WHERE is_internal = true LIMIT 1',
		);
		const ceoId = await instanceCeoId(db);
		const { token: ceoTok } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			DEFAULT_TEAM_ID,
			null,
			{ crossProject: true },
		);
		const forbidden = await call(ceoTok, 'update_project_progress', {
			project: hq.rows[0].slug,
			summary: 'x',
		});
		expect(forbidden.error).toBe('The HQ project has no progress summary');
	});

	it('update_goal_progress validates run context and goal existence', async () => {
		const denied = await admin('update_goal_progress', {
			project: projectSlug,
			goal_id: crypto.randomUUID(),
			progress_percent: 10,
			health: 'on_track',
			status_blurb: 'x',
		});
		expect(denied.error).toBe('update_goal_progress can only be called from within an agent run');

		const at = await agentToken(captainId, teamId, taskId);
		const missing = await call(at, 'update_goal_progress', {
			goal_id: crypto.randomUUID(),
			progress_percent: 10,
			health: 'on_track',
			status_blurb: 'x',
		});
		expect(String(missing.error)).toContain('Goal not found in project');
	});
});

describe('read tools', () => {
	it('list_team_templates returns builtin templates with agent types', async () => {
		const r = (await admin('list_team_templates')) as unknown as Array<{
			name: string;
			is_builtin: boolean;
			agent_types: Array<{ slug: string }>;
		}>;
		const startup = r.find((t) => t.name === 'Startup');
		expect(startup?.is_builtin).toBe(true);
		expect(startup?.agent_types.map((a) => a.slug)).toContain('engineer');
	});

	it('list_agents returns the roster with budgets and statuses', async () => {
		const r = (await admin('list_agents', { project: projectSlug })) as unknown as Array<{
			slug: string;
			admin_status: string;
		}>;
		expect(r.map((a) => a.slug)).toContain('engineer');
		expect(r.every((a) => typeof a.admin_status === 'string')).toBe(true);
	});

	it('get_costs supports group_by agent and day', async () => {
		const byAgent = await admin('get_costs', { project: projectSlug, group_by: 'agent' });
		expect(Array.isArray(byAgent)).toBe(true);
		const byDay = await admin('get_costs', { project: projectSlug, group_by: 'day' });
		expect(Array.isArray(byDay)).toBe(true);
		const total = await admin('get_costs', { project: projectSlug });
		expect(total.error).toBeUndefined();
	});

	it('full_text_search finds the seeded task', async () => {
		const r = (await admin('full_text_search', {
			project: projectSlug,
			query: 'Seed Task',
		})) as {
			results: Array<{ title?: string }>;
			count: number;
		};
		expect(r.count).toBeGreaterThan(0);
	});

	it('list_approvals returns pending approvals for the team', async () => {
		const at = await agentToken(engineerId, teamId, taskId);
		const proposed = await call(at, 'propose_skill', {
			skill_name: 'Proposed Skill',
			skill_slug: 'proposed-skill',
			content: '# Proposed\n\nA skill body.',
			reason: 'Testing approvals listing.',
		});
		expect(proposed.error).toBeUndefined();
		const r = (await admin('list_approvals', {
			project: projectSlug,
			excerpt_chars: 10,
		})) as unknown as Array<{ type: string }>;
		expect(r.length).toBeGreaterThan(0);
	});
});

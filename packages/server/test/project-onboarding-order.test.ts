import { DEFAULT_TEAM_ID } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, instanceCeoId, mintAgentToken } from './helpers/app';
import { callMcpTool } from './helpers/mcp-call';

// A new project starts in a fixed order: the CEO's team setup, then the CEO's
// starter task suggestions, then the Captain's planning. Approved suggestions
// wait for planning. Each step starts when the one before it closes.

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let ceoId: string;
let appTeamTemplateId: string;

interface Created {
	id: string;
	slug: string;
	team_id: string;
	planning_task_id: string;
	setup_task_id: string;
	suggestions_task_id: string;
	suggestions_task_identifier: string;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	ceoId = await instanceCeoId(db);
	const res = await app.request('/api/team-templates', { headers: authHeader(token) });
	appTeamTemplateId = (await res.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
});

afterAll(async () => {
	await safeClose(db);
});

async function status(taskId: string): Promise<string> {
	const r = await db.query<{ status: string }>(
		'SELECT status::text AS status FROM tasks WHERE id = $1',
		[taskId],
	);
	return r.rows[0].status;
}

async function wakeCount(memberId: string, taskId: string): Promise<number> {
	const r = await db.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM agent_wakeup_requests
		 WHERE member_id = $1 AND payload->>'task_id' = $2`,
		[memberId, taskId],
	);
	return r.rows[0].n;
}

/** The admin closes a task, as from the task page. */
async function close(slug: string, taskId: string): Promise<void> {
	const res = await app.request(`/api/projects/${slug}/tasks/${taskId}`, {
		method: 'PATCH',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ status: 'done' }),
	});
	expect(res.status).toBe(200);
}

async function captainOf(teamId: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
		[teamId],
	);
	return r.rows[0].id;
}

describe('new project, created from the form', () => {
	it('runs setup, then suggestions, then planning, and approved tasks wait for planning', async () => {
		const res = await app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Order Watch',
				description: 'Track a portfolio.',
				template_id: appTeamTemplateId,
			}),
		});
		expect(res.status).toBe(201);
		const p = (await res.json()).data as Created;
		const captainId = await captainOf(p.team_id);

		// Suggestions is assigned to the CEO but waits, with no wake, until setup closes.
		expect(await status(p.suggestions_task_id)).toBe('blocked');
		expect(await wakeCount(ceoId, p.suggestions_task_id)).toBe(0);
		expect(await status(p.planning_task_id)).toBe('blocked');

		await close(p.slug, p.setup_task_id);
		expect(await status(p.suggestions_task_id)).toBe('backlog');
		expect(await wakeCount(ceoId, p.suggestions_task_id)).toBe(1);
		// Planning still waits on suggestions.
		expect(await status(p.planning_task_id)).toBe('blocked');

		// The CEO files a card from its suggestions run; the admin approves it.
		const { token: ceoRun, runId } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			p.team_id,
			p.suggestions_task_id,
		);
		const suggested = (await callMcpTool(app, ceoRun, 'suggest_task', {
			project: p.slug,
			kind: 'recurring',
			title: 'Weekly news catch-up',
			cadence: 'weekly',
			task_id: p.suggestions_task_identifier,
		})) as { approval_id: string };
		const resolved = await app.request(`/api/approvals/${suggested.approval_id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'approved' }),
		});
		expect(resolved.status).toBe(200);
		const approved = await db.query<{ id: string }>(
			'SELECT id FROM tasks WHERE project_id = $1 AND title = $2',
			[p.id, 'Weekly news catch-up'],
		);
		const approvedId = approved.rows[0].id;
		expect(await status(approvedId)).toBe('blocked');

		// The CEO's run ends before the admin closes its task.
		await db.query(
			`UPDATE heartbeat_runs SET status = 'succeeded'::heartbeat_run_status WHERE id = $1`,
			[runId],
		);
		await close(p.slug, p.suggestions_task_id);
		expect(await status(p.planning_task_id)).toBe('backlog');
		expect(await wakeCount(captainId, p.planning_task_id)).toBeGreaterThanOrEqual(1);
		// The approved task still waits on planning.
		expect(await status(approvedId)).toBe('blocked');

		await close(p.slug, p.planning_task_id);
		expect(await status(approvedId)).toBe('backlog');
		expect(await wakeCount(captainId, approvedId)).toBeGreaterThanOrEqual(1);
	});
});

describe('new project, created by the CEO in its chat', () => {
	it('keeps suggestions waiting on the setup the CEO starts itself', async () => {
		const { token: chat } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			DEFAULT_TEAM_ID,
			null,
			{
				crossProject: true,
			},
		);
		const p = (await callMcpTool(app, chat, 'create_project', {
			name: 'Chat Order Watch',
			description: 'Planned in the CEO chat.',
			template_id: appTeamTemplateId,
		})) as unknown as Created & { error?: string };
		expect(p.error).toBeUndefined();
		expect(p.suggestions_task_identifier).toBeTruthy();

		// Setup is unassigned until start_team_setup; suggestions is the CEO's, waiting.
		const tasks = await db.query<{ id: string; assignee_id: string | null }>(
			'SELECT id, assignee_id FROM tasks WHERE id = ANY($1::uuid[])',
			[[p.setup_task_id, p.suggestions_task_id]],
		);
		const byId = new Map(tasks.rows.map((r) => [r.id, r.assignee_id]));
		expect(byId.get(p.setup_task_id)).toBeNull();
		expect(byId.get(p.suggestions_task_id)).toBe(ceoId);
		expect(await status(p.suggestions_task_id)).toBe('blocked');

		const started = (await callMcpTool(app, chat, 'start_team_setup', {
			project: p.slug,
		})) as { started?: boolean };
		expect(started.started).toBe(true);
		expect(await status(p.suggestions_task_id)).toBe('blocked');
		expect(await wakeCount(ceoId, p.suggestions_task_id)).toBe(0);

		await close(p.slug, p.setup_task_id);
		expect(await status(p.suggestions_task_id)).toBe('backlog');
		expect(await wakeCount(ceoId, p.suggestions_task_id)).toBe(1);
	});
});

describe('the CEO creating a project twice', () => {
	it('refuses a name an existing project uses, naming that project', async () => {
		const { token: chat } = await mintAgentToken(
			db,
			masterKeyManager,
			ceoId,
			DEFAULT_TEAM_ID,
			null,
			{
				crossProject: true,
			},
		);
		const first = (await callMcpTool(app, chat, 'create_project', {
			name: 'Retry Watch',
			description: 'Created once.',
			template_id: appTeamTemplateId,
		})) as { slug?: string; error?: string };
		expect(first.error).toBeUndefined();

		// A retry after a lost result, with different casing and spacing.
		const retry = (await callMcpTool(app, chat, 'create_project', {
			name: '  retry watch ',
			description: 'Created twice?',
			template_id: appTeamTemplateId,
		})) as { error?: string };
		expect(retry.error).toContain(`already exists (${first.slug})`);
		const n = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM projects WHERE LOWER(name) = 'retry watch'`,
		);
		expect(n.rows[0].n).toBe(1);
	});
});

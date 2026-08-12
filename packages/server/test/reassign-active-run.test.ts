import { CAPTAIN_AGENT_SLUG, HeartbeatRunStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { assertNoBlockingRun } from '../src/lib/reassign-guard';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
	projectSlugFor,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;

let captainId: string;
let architectId: string;
let engineerId: string;
let qaEngineerId: string;

async function callTool(
	bearer: string,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(bearer), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	return JSON.parse(body.result.content[0].text);
}

/** A run on `taskId` owned by `memberId`, in whatever state the case needs. */
async function insertRun(
	memberId: string,
	taskId: string,
	status: HeartbeatRunStatus = HeartbeatRunStatus.Running,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())
		 RETURNING id`,
		[memberId, teamId, taskId, status],
	);
	return r.rows[0].id;
}

async function dropRun(runId: string): Promise<void> {
	await db.query('DELETE FROM heartbeat_runs WHERE id = $1', [runId]);
}

async function createTask(title: string, assigneeId: string): Promise<string> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title, assignee_id: assigneeId }),
	});
	return (await res.json()).data.id;
}

async function assigneeOf(taskId: string): Promise<string | null> {
	const r = await db.query<{ assignee_id: string | null }>(
		'SELECT assignee_id FROM tasks WHERE id = $1',
		[taskId],
	);
	return r.rows[0]?.assignee_id ?? null;
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

	const teamRes = await createTestTeam(db, { name: 'Reassign Test Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const setupSlug = (await (await createTestProject(db, teamId, { name: 'Setup Project' })).json())
		.data.slug;
	const agentsRes = await app.request(`/api/projects/${setupSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	const bySlug = (slug: string) => agents.find((a) => a.slug === slug)!.id;
	captainId = bySlug(CAPTAIN_AGENT_SLUG);
	architectId = bySlug('architect');
	engineerId = bySlug('engineer');
	qaEngineerId = bySlug('qa-engineer');

	const projectRes = await createTestProject(db, teamId, {
		name: 'Reassign Project',
		description: 'Project for reassignment-guard tests.',
	});
	projectId = (await projectRes.json()).data.id;
	projectSlug = await projectSlugFor(db, teamId);
});

afterAll(async () => {
	await safeClose(db);
});

describe('assertNoBlockingRun (unit)', () => {
	const noExemption = { callerMemberId: null, incomingAssigneeId: null };

	it('allows the change when the task carries no run', async () => {
		const taskId = await createTask('No run at all', engineerId);
		const result = await assertNoBlockingRun(db, taskId, {
			callerMemberId: architectId,
			incomingAssigneeId: engineerId,
		});
		expect(result.ok).toBe(true);
	});

	it("blocks on a third party's running run and names them", async () => {
		const taskId = await createTask('Third party running', engineerId);
		const runId = await insertRun(engineerId, taskId);
		try {
			const result = await assertNoBlockingRun(db, taskId, {
				callerMemberId: architectId,
				incomingAssigneeId: qaEngineerId,
			});
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.message).toContain('@engineer');
			expect(result.message).toContain('is running on this task');
		} finally {
			await dropRun(runId);
		}
	});

	it("blocks on a third party's queued run with queued-specific wording", async () => {
		const taskId = await createTask('Third party queued', engineerId);
		const runId = await insertRun(engineerId, taskId, HeartbeatRunStatus.Queued);
		try {
			const result = await assertNoBlockingRun(db, taskId, {
				callerMemberId: architectId,
				incomingAssigneeId: qaEngineerId,
			});
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.message).toContain('@engineer');
			expect(result.message).toContain('has a run queued on this task');
		} finally {
			await dropRun(runId);
		}
	});

	it("allows the change when the only run is the caller's own (running)", async () => {
		const taskId = await createTask('Own running run', architectId);
		const runId = await insertRun(architectId, taskId);
		try {
			const result = await assertNoBlockingRun(db, taskId, {
				callerMemberId: architectId,
				incomingAssigneeId: engineerId,
			});
			expect(result.ok).toBe(true);
		} finally {
			await dropRun(runId);
		}
	});

	it("allows the change when the only run is the caller's own (queued)", async () => {
		const taskId = await createTask('Own queued run', architectId);
		const runId = await insertRun(architectId, taskId, HeartbeatRunStatus.Queued);
		try {
			const result = await assertNoBlockingRun(db, taskId, {
				callerMemberId: architectId,
				incomingAssigneeId: engineerId,
			});
			expect(result.ok).toBe(true);
		} finally {
			await dropRun(runId);
		}
	});

	it('allows the change when the run belongs to the incoming assignee', async () => {
		const taskId = await createTask('Incoming assignee is running it', architectId);
		const runId = await insertRun(engineerId, taskId);
		try {
			const result = await assertNoBlockingRun(db, taskId, {
				callerMemberId: captainId,
				incomingAssigneeId: engineerId,
			});
			expect(result.ok).toBe(true);
		} finally {
			await dropRun(runId);
		}
	});

	// Regression test for the exemption predicate. It MUST be written with
	// `IS DISTINCT FROM`: an admin caller passes NULL for both fields, and under a
	// plain `<>` the comparison yields NULL, the row is filtered out, and every
	// admin reassignment silently goes unguarded.
	it('blocks when neither exemption is supplied (admin / API-key caller)', async () => {
		const taskId = await createTask('Admin caller, no exemptions', engineerId);
		const runId = await insertRun(engineerId, taskId);
		try {
			const result = await assertNoBlockingRun(db, taskId, noExemption);
			expect(result.ok).toBe(false);
		} finally {
			await dropRun(runId);
		}
	});

	it('ignores runs that have reached a terminal status', async () => {
		const taskId = await createTask('Terminal run', engineerId);
		const runId = await insertRun(engineerId, taskId);
		await db.query(
			`UPDATE heartbeat_runs SET status = $1::heartbeat_run_status, finished_at = now() WHERE id = $2`,
			[HeartbeatRunStatus.Succeeded, runId],
		);
		try {
			const result = await assertNoBlockingRun(db, taskId, noExemption);
			expect(result.ok).toBe(true);
		} finally {
			await dropRun(runId);
		}
	});

	it('falls back to the display name when the blocking member is not an agent', async () => {
		const human = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, display_name, member_type)
			 VALUES ($1, 'Dana Human', 'user') RETURNING id`,
			[teamId],
		);
		const humanId = human.rows[0].id;
		const taskId = await createTask('Blocked by a non-agent member', engineerId);
		const runId = await insertRun(humanId, taskId);
		try {
			const result = await assertNoBlockingRun(db, taskId, noExemption);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.message).toContain('Dana Human');
			expect(result.message).not.toContain('@Dana');
		} finally {
			await dropRun(runId);
			await db.query('DELETE FROM members WHERE id = $1', [humanId]);
		}
	});
});

describe('MCP update_task: handing off a task you are running', () => {
	// The regression this whole guard change exists for. Note the token is minted
	// WITH the task id, so the caller's own run sits on the task being reassigned -
	// the state that used to be an unbreakable deadlock, because an agent JWT only
	// authenticates while its own run row is `running`.
	it('lets an agent hand off the task its own run is executing', async () => {
		const taskId = await createTask('Architect hands off mid-run', architectId);
		const { token: archToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
			{ projectId },
		);

		const result = await callTool(archToken, 'update_task', {
			project: projectId,
			task_id: taskId,
			assignee_id: engineerId,
		});
		expect(result.error).toBeUndefined();
		expect(await assigneeOf(taskId)).toBe(engineerId);
	});

	it('records the handoff in the task thread and wakes the new owner', async () => {
		const taskId = await createTask('Handoff leaves a trail', architectId);
		const { token: archToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
			{ projectId },
		);
		await callTool(archToken, 'update_task', {
			project: projectId,
			task_id: taskId,
			assignee_id: engineerId,
		});

		const comments = await db.query<{ content: Record<string, unknown> }>(
			`SELECT content FROM task_comments
			 WHERE task_id = $1 AND content_type = 'system'
			   AND content->>'kind' = 'assignee_change'`,
			[taskId],
		);
		expect(comments.rows).toHaveLength(1);
		expect(comments.rows[0].content.from_id).toBe(architectId);
		expect(comments.rows[0].content.to_id).toBe(engineerId);

		// The wakeup is fire-and-forget, so give the tracked background work a tick.
		await new Promise((r) => setTimeout(r, 100));
		const wakeups = await db.query<{ id: string }>(
			`SELECT id FROM agent_wakeup_requests
			 WHERE member_id = $1 AND source = 'assignment'::wakeup_source
			   AND payload->>'task_id' = $2`,
			[engineerId, taskId],
		);
		expect(wakeups.rows.length).toBeGreaterThan(0);
	});

	it("still blocks a reassignment across another agent's live run, and names them", async () => {
		const taskId = await createTask('Engineer is working this', engineerId);
		const blockingRun = await insertRun(engineerId, taskId);
		const ownTaskId = await createTask("Captain's own task", captainId);
		const { token: capToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			ownTaskId,
			{ projectId },
		);
		try {
			const result = await callTool(capToken, 'update_task', {
				project: projectId,
				task_id: taskId,
				assignee_id: architectId,
			});
			expect(result.error).toContain('@engineer');
			expect(await assigneeOf(taskId)).toBe(engineerId);
		} finally {
			await dropRun(blockingRun);
		}
	});

	// The caller here is the architect (engineer's manager, so the hierarchy rule is
	// satisfied) running on a different task. The blocking run belongs to the agent
	// the task is moving TO, so the incoming-assignee exemption is what clears it.
	it('allows moving a task to whichever agent is already running it', async () => {
		const taskId = await createTask('Ownership correction', qaEngineerId);
		const blockingRun = await insertRun(engineerId, taskId);
		const ownTaskId = await createTask("Architect's other task", architectId);
		const { token: archToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			ownTaskId,
			{ projectId },
		);
		try {
			const result = await callTool(archToken, 'update_task', {
				project: projectId,
				task_id: taskId,
				assignee_id: engineerId,
			});
			expect(result.error).toBeUndefined();
			expect(await assigneeOf(taskId)).toBe(engineerId);
		} finally {
			await dropRun(blockingRun);
		}
	});

	// The caller exemption must not become a way around the hierarchy rule.
	it("does not let a caller's own run exempt it from the subordinate rule", async () => {
		const taskId = await createTask('Engineer tries to dump on QA mid-run', engineerId);
		const { token: engToken } = await mintAgentToken(
			db,
			masterKeyManager,
			engineerId,
			teamId,
			taskId,
			{ projectId },
		);

		const result = await callTool(engToken, 'update_task', {
			project: projectId,
			task_id: taskId,
			assignee_id: qaEngineerId,
		});
		expect(result.error).toContain('@qa-engineer');
		expect(await assigneeOf(taskId)).toBe(engineerId);
	});
});

describe('REST PATCH: agent callers get the same rules as the MCP twin', () => {
	async function patchAssignee(
		bearer: string,
		taskId: string,
		assigneeId: string,
	): Promise<Response> {
		return app.request(`/api/projects/${projectSlug}/tasks/${taskId}`, {
			method: 'PATCH',
			headers: { ...authHeader(bearer), 'Content-Type': 'application/json' },
			body: JSON.stringify({ assignee_id: assigneeId }),
		});
	}

	it('lets an agent hand off the task its own run is executing', async () => {
		const taskId = await createTask('REST handoff mid-run', architectId);
		const { token: archToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
			{ projectId },
		);
		const res = await patchAssignee(archToken, taskId, engineerId);
		expect(res.status).toBe(200);
		expect(await assigneeOf(taskId)).toBe(engineerId);
	});

	// REST never enforced the hierarchy rule; the unconditional run guard used to
	// hide that, because an agent reaching here from inside its own run was 409'd
	// first. Exempting the caller's own run opens the path, so the rule has to hold
	// on this surface too.
	it('rejects an agent reassigning its own live task to a peer', async () => {
		const taskId = await createTask('REST peer dump attempt', engineerId);
		const { token: engToken } = await mintAgentToken(
			db,
			masterKeyManager,
			engineerId,
			teamId,
			taskId,
			{ projectId },
		);
		const res = await patchAssignee(engToken, taskId, qaEngineerId);
		expect(res.status).toBe(403);
		expect(await assigneeOf(taskId)).toBe(engineerId);
	});

	it("still 409s an agent reaching across another agent's live run", async () => {
		const taskId = await createTask('REST cross-agent attempt', engineerId);
		const blockingRun = await insertRun(engineerId, taskId);
		const ownTaskId = await createTask('Captain REST own task', captainId);
		const { token: capToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			ownTaskId,
			{ projectId },
		);
		try {
			const res = await patchAssignee(capToken, taskId, architectId);
			expect(res.status).toBe(409);
			expect((await res.json()).error.message).toContain('@engineer');
			expect(await assigneeOf(taskId)).toBe(engineerId);
		} finally {
			await dropRun(blockingRun);
		}
	});

	it('lets an admin move a task to the agent already running it', async () => {
		const taskId = await createTask('Admin ownership correction', architectId);
		const blockingRun = await insertRun(engineerId, taskId);
		try {
			const res = await patchAssignee(token, taskId, engineerId);
			expect(res.status).toBe(200);
			expect(await assigneeOf(taskId)).toBe(engineerId);
		} finally {
			await dropRun(blockingRun);
		}
	});

	it("still 409s an admin reaching across a third party's live run", async () => {
		const taskId = await createTask('Admin cross-agent attempt', architectId);
		const blockingRun = await insertRun(engineerId, taskId);
		try {
			const res = await patchAssignee(token, taskId, qaEngineerId);
			expect(res.status).toBe(409);
			expect(await assigneeOf(taskId)).toBe(architectId);
		} finally {
			await dropRun(blockingRun);
		}
	});
});

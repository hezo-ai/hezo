import type { PGlite } from '@electric-sql/pglite';
import { TaskStatus, WakeupSource, WakeupStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	hasOpenBlockers,
	shouldDeferWakeupForBlockers,
	wakeIfReady,
	wouldCreateCycle,
} from '../src/lib/dependencies';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject } from './helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let teamId: string;
let projectId: string;
let researcherId: string;
let productLeadId: string;
let architectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const teamTemplateId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Dep Gate Co', template_id: teamTemplateId }),
	});
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Gate Project',
		description: 'Test project.',
	});
	projectId = (await projectRes.json()).data.id;

	const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	researcherId = agents.find((a) => a.slug === 'researcher')!.id;
	productLeadId = agents.find((a) => a.slug === 'product-lead')!.id;
	architectId = agents.find((a) => a.slug === 'architect')!.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function createTask(
	title: string,
	assigneeId: string,
	blockedBy?: string[],
): Promise<{ id: string; identifier: string }> {
	const res = await app.request(`/api/teams/${teamId}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title,
			assignee_id: assigneeId,
			...(blockedBy ? { blocked_by_task_ids: blockedBy } : {}),
		}),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data;
}

async function setStatus(taskId: string, status: string): Promise<void> {
	const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}`, {
		method: 'PATCH',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ status }),
	});
	expect(res.status).toBe(200);
}

async function getWakeupForTask(
	memberId: string,
	taskId: string,
): Promise<{ status: string; payload: Record<string, unknown> } | null> {
	const r = await db.query<{ status: string; payload: Record<string, unknown> }>(
		`SELECT status::text AS status, payload
		 FROM agent_wakeup_requests
		 WHERE member_id = $1 AND payload->>'task_id' = $2
		 ORDER BY created_at DESC LIMIT 1`,
		[memberId, taskId],
	);
	return r.rows[0] ?? null;
}

describe('dependency gate — hasOpenBlockers / cycles', () => {
	it('reports no blockers for a fresh task', async () => {
		const a = await createTask('A solo', researcherId);
		expect(await hasOpenBlockers(db, a.id)).toBe(false);
	});

	it('reports blocked while upstream is open and unblocked once terminal', async () => {
		const upstream = await createTask('Upstream', researcherId);
		const downstream = await createTask('Downstream', productLeadId, [upstream.identifier]);

		expect(await hasOpenBlockers(db, downstream.id)).toBe(true);

		await setStatus(upstream.id, TaskStatus.InProgress);
		expect(await hasOpenBlockers(db, downstream.id)).toBe(true);

		await setStatus(upstream.id, TaskStatus.Done);
		expect(await hasOpenBlockers(db, downstream.id)).toBe(false);
	});

	it('rejects direct self-cycles and reachable-loop cycles', async () => {
		const a = await createTask('Cycle A', researcherId);
		const b = await createTask('Cycle B', productLeadId, [a.identifier]);
		const c = await createTask('Cycle C', architectId, [b.identifier]);

		expect(await wouldCreateCycle(db, a.id, a.id)).toBe(true);
		expect(await wouldCreateCycle(db, a.id, c.id)).toBe(true);
		expect(await wouldCreateCycle(db, a.id, b.id)).toBe(true);
		expect(await wouldCreateCycle(db, b.id, a.id)).toBe(false);
	});

	it('createTask rejects blocked_by entries that form a cycle', async () => {
		const a = await createTask('cycle-create A', researcherId);
		const b = await createTask('cycle-create B', productLeadId, [a.identifier]);

		const res = await app.request(`/api/teams/${teamId}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'closes the loop',
				assignee_id: architectId,
				blocked_by_task_ids: [b.identifier],
			}),
		});
		expect(res.status).toBe(201);
		const c = (await res.json()).data as { id: string };

		const aBlockedByC = await app.request(`/api/teams/${teamId}/tasks/${a.id}/dependencies`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ blocked_by_task_id: c.id }),
		});
		expect(aBlockedByC.status).toBe(400);
	});
});

describe('dependency gate — wakeup deferral and reverse trigger', () => {
	it('defers an assignment wakeup whose target has open blockers', async () => {
		const r = await createTask('research', researcherId);
		const p = await createTask('prd', productLeadId, [r.identifier]);

		await new Promise((res) => setTimeout(res, 50));
		const pWakeup = await getWakeupForTask(productLeadId, p.id);
		expect(pWakeup).not.toBeNull();

		const decision = await shouldDeferWakeupForBlockers(db, WakeupSource.Assignment, p.id);
		expect(decision).toBe(true);

		const upstreamDecision = await shouldDeferWakeupForBlockers(db, WakeupSource.Assignment, r.id);
		expect(upstreamDecision).toBe(false);
	});

	it('lets mention wakeups bypass the gate even on a blocked ticket', async () => {
		const r = await createTask('research-bypass', researcherId);
		const p = await createTask('prd-bypass', productLeadId, [r.identifier]);

		expect(await shouldDeferWakeupForBlockers(db, WakeupSource.Mention, p.id)).toBe(false);
		expect(await shouldDeferWakeupForBlockers(db, WakeupSource.Comment, p.id)).toBe(false);
		expect(await shouldDeferWakeupForBlockers(db, WakeupSource.Reply, p.id)).toBe(false);
		expect(await shouldDeferWakeupForBlockers(db, WakeupSource.Automation, p.id)).toBe(false);
	});

	it('does not defer wakeups on terminal-status tickets', async () => {
		const r = await createTask('research-done', researcherId);
		const p = await createTask('prd-done', productLeadId, [r.identifier]);
		await setStatus(p.id, TaskStatus.Done);
		expect(await shouldDeferWakeupForBlockers(db, WakeupSource.Assignment, p.id)).toBe(false);
	});

	it('flips deferred wakeup to queued when blocker closes', async () => {
		const r = await createTask('research-chain', researcherId);
		const p = await createTask('prd-chain', productLeadId, [r.identifier]);

		await new Promise((res) => setTimeout(res, 50));
		const wakeup = await getWakeupForTask(productLeadId, p.id);
		expect(wakeup).not.toBeNull();

		await db.query(
			`UPDATE agent_wakeup_requests
			 SET status = $1::wakeup_status, payload = payload || '{"reason":"blocked"}'::jsonb
			 WHERE member_id = $2 AND payload->>'task_id' = $3`,
			[WakeupStatus.Deferred, productLeadId, p.id],
		);

		await setStatus(r.id, TaskStatus.Done);
		await new Promise((res) => setTimeout(res, 100));

		const after = await getWakeupForTask(productLeadId, p.id);
		expect(after?.status).toBe(WakeupStatus.Queued);
	});

	it('cascades through a two-step chain', async () => {
		const r = await createTask('chain2-r', researcherId);
		const p = await createTask('chain2-p', productLeadId, [r.identifier]);
		const s = await createTask('chain2-s', architectId, [p.identifier]);

		await new Promise((res) => setTimeout(res, 50));
		for (const [member, task] of [
			[productLeadId, p.id],
			[architectId, s.id],
		] as const) {
			await db.query(
				`UPDATE agent_wakeup_requests
				 SET status = $1::wakeup_status, payload = payload || '{"reason":"blocked"}'::jsonb
				 WHERE member_id = $2 AND payload->>'task_id' = $3`,
				[WakeupStatus.Deferred, member, task],
			);
		}

		await setStatus(r.id, TaskStatus.Done);
		await new Promise((res) => setTimeout(res, 100));

		const afterFirst = await getWakeupForTask(architectId, s.id);
		expect(afterFirst?.status).toBe(WakeupStatus.Deferred);

		await setStatus(p.id, TaskStatus.Done);
		await new Promise((res) => setTimeout(res, 100));

		const afterSecond = await getWakeupForTask(architectId, s.id);
		expect(afterSecond?.status).toBe(WakeupStatus.Queued);
	});

	it('unblocks when a dependency edge is removed via the REST endpoint', async () => {
		const r = await createTask('edge-r', researcherId);
		const p = await createTask('edge-p', productLeadId, [r.identifier]);

		await new Promise((res) => setTimeout(res, 50));
		await db.query(
			`UPDATE agent_wakeup_requests
			 SET status = $1::wakeup_status, payload = payload || '{"reason":"blocked"}'::jsonb
			 WHERE member_id = $2 AND payload->>'task_id' = $3`,
			[WakeupStatus.Deferred, productLeadId, p.id],
		);

		const depsRes = await app.request(`/api/teams/${teamId}/tasks/${p.id}/dependencies`, {
			headers: authHeader(token),
		});
		const deps = (await depsRes.json()).data as Array<{ id: string }>;
		expect(deps.length).toBe(1);

		const delRes = await app.request(
			`/api/teams/${teamId}/tasks/${p.id}/dependencies/${deps[0].id}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(delRes.status).toBe(200);

		const after = await getWakeupForTask(productLeadId, p.id);
		expect(after?.status).toBe(WakeupStatus.Queued);
	});

	it('wakeIfReady creates a fresh assignment wakeup when none is deferred', async () => {
		const r = await createTask('fresh-r', researcherId);
		const p = await createTask('fresh-p', productLeadId, [r.identifier]);

		await new Promise((res) => setTimeout(res, 50));
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [productLeadId]);

		await setStatus(r.id, TaskStatus.Done);
		await new Promise((res) => setTimeout(res, 100));

		const after = await getWakeupForTask(productLeadId, p.id);
		expect(after).not.toBeNull();
		expect(after?.status).toBe(WakeupStatus.Queued);
	});

	it('cascade unblock records a system comment attributed to the system, linking back to the closed blocker', async () => {
		const r = await createTask('attr-r', researcherId);
		const p = await createTask('attr-p', productLeadId, [r.identifier]);

		await setStatus(r.id, TaskStatus.Done);
		await new Promise((res) => setTimeout(res, 100));

		const comments = await db.query<{
			author_member_id: string | null;
			content: Record<string, unknown>;
		}>(
			`SELECT author_member_id, content FROM task_comments
			 WHERE task_id = $1 AND content_type = 'system'
			   AND content->>'kind' = 'status_change'
			 ORDER BY created_at DESC LIMIT 1`,
			[p.id],
		);
		const row = comments.rows[0];
		expect(row).toBeDefined();
		expect(row.author_member_id).toBeNull();
		expect(row.content.cascade).toBe('auto_unblock');
		expect(row.content.triggered_by_task_id).toBe(r.id);
		expect(row.content.triggered_by_identifier).toBe(r.identifier);
		expect(typeof row.content.triggered_by_project_slug).toBe('string');
		expect(row.content.from).toBe(TaskStatus.Blocked);
		expect(row.content.to).toBe(TaskStatus.Backlog);
	});

	it('manual Blocked→Backlog (dependency edge removed) is attributed to the actor — no cascade marker', async () => {
		const r = await createTask('manual-attr-r', researcherId);
		const p = await createTask('manual-attr-p', productLeadId, [r.identifier]);
		const depsRes = await app.request(`/api/teams/${teamId}/tasks/${p.id}/dependencies`, {
			headers: authHeader(token),
		});
		const dep = (await depsRes.json()).data[0] as { id: string };
		await deleteDependency(p.id, dep.id);

		const comments = await db.query<{
			author_member_id: string | null;
			content: Record<string, unknown>;
		}>(
			`SELECT author_member_id, content FROM task_comments
			 WHERE task_id = $1 AND content_type = 'system'
			   AND content->>'kind' = 'status_change'
			 ORDER BY created_at DESC LIMIT 1`,
			[p.id],
		);
		const row = comments.rows[0];
		expect(row).toBeDefined();
		expect(row.content.cascade).toBeUndefined();
		expect(row.content.from).toBe(TaskStatus.Blocked);
		expect(row.content.to).toBe(TaskStatus.Backlog);
	});

	it('wakeIfReady is a no-op when blockers remain', async () => {
		const r1 = await createTask('twoblock-r1', researcherId);
		const r2 = await createTask('twoblock-r2', researcherId);
		const p = await createTask('twoblock-p', productLeadId, [r1.identifier, r2.identifier]);

		await new Promise((res) => setTimeout(res, 50));
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [productLeadId]);

		await setStatus(r1.id, TaskStatus.Done);
		await new Promise((res) => setTimeout(res, 100));

		await wakeIfReady(db, p.id);
		const after = await getWakeupForTask(productLeadId, p.id);
		expect(after).toBeNull();
	});
});

async function getTaskStatus(taskId: string): Promise<string> {
	const r = await db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId]);
	return r.rows[0]?.status ?? '';
}

async function addDependency(taskId: string, blockerIdentifier: string): Promise<{ id: string }> {
	const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}/dependencies`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ blocked_by_task_id: blockerIdentifier }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data;
}

async function deleteDependency(taskId: string, depId: string): Promise<void> {
	const res = await app.request(`/api/teams/${teamId}/tasks/${taskId}/dependencies/${depId}`, {
		method: 'DELETE',
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
}

describe('blocked-status invariant', () => {
	it('flips backlog to blocked when a dependency is added', async () => {
		const upstream = await createTask('inv-up', researcherId);
		const downstream = await createTask('inv-down', productLeadId);
		expect(await getTaskStatus(downstream.id)).toBe(TaskStatus.Backlog);

		await addDependency(downstream.id, upstream.identifier);

		expect(await getTaskStatus(downstream.id)).toBe(TaskStatus.Blocked);
	});

	it('does not flip when the new blocker is already terminal', async () => {
		const upstream = await createTask('inv-up-done', researcherId);
		await setStatus(upstream.id, TaskStatus.Done);
		const downstream = await createTask('inv-down-done-up', productLeadId);

		await addDependency(downstream.id, upstream.identifier);

		expect(await getTaskStatus(downstream.id)).toBe(TaskStatus.Backlog);
	});

	it('flips blocked back to backlog when the last open dependency is removed', async () => {
		const upstream = await createTask('inv-remove-up', researcherId);
		const downstream = await createTask('inv-remove-down', productLeadId);
		const dep = await addDependency(downstream.id, upstream.identifier);
		expect(await getTaskStatus(downstream.id)).toBe(TaskStatus.Blocked);

		await deleteDependency(downstream.id, dep.id);

		expect(await getTaskStatus(downstream.id)).toBe(TaskStatus.Backlog);
	});

	it('stays blocked when one of several dependencies is removed', async () => {
		const u1 = await createTask('inv-multi-1', researcherId);
		const u2 = await createTask('inv-multi-2', researcherId);
		const down = await createTask('inv-multi-down', productLeadId);
		const d1 = await addDependency(down.id, u1.identifier);
		await addDependency(down.id, u2.identifier);
		expect(await getTaskStatus(down.id)).toBe(TaskStatus.Blocked);

		await deleteDependency(down.id, d1.id);

		expect(await getTaskStatus(down.id)).toBe(TaskStatus.Blocked);
	});

	it('coerces a PATCH to in_progress to blocked when open blockers exist', async () => {
		const upstream = await createTask('inv-coerce-up', researcherId);
		const downstream = await createTask('inv-coerce-down', productLeadId);
		await addDependency(downstream.id, upstream.identifier);

		await setStatus(downstream.id, TaskStatus.InProgress);

		expect(await getTaskStatus(downstream.id)).toBe(TaskStatus.Blocked);
	});

	it('coerces a PATCH to blocked into backlog when no blockers exist', async () => {
		const task = await createTask('inv-coerce-blocked', productLeadId);

		await setStatus(task.id, TaskStatus.Blocked);

		expect(await getTaskStatus(task.id)).toBe(TaskStatus.Backlog);
	});

	it('flips downstream blocked to backlog when the upstream blocker hits done', async () => {
		const upstream = await createTask('inv-up-flip', researcherId);
		const downstream = await createTask('inv-down-flip', productLeadId);
		await addDependency(downstream.id, upstream.identifier);
		expect(await getTaskStatus(downstream.id)).toBe(TaskStatus.Blocked);

		await setStatus(upstream.id, TaskStatus.Done);
		await new Promise((res) => setTimeout(res, 100));

		expect(await getTaskStatus(downstream.id)).toBe(TaskStatus.Backlog);
	});

	it('flips downstream back to blocked when an upstream leaves terminal', async () => {
		const upstream = await createTask('inv-leave-up', researcherId);
		const downstream = await createTask('inv-leave-down', productLeadId);
		await addDependency(downstream.id, upstream.identifier);
		await setStatus(upstream.id, TaskStatus.Done);
		await new Promise((res) => setTimeout(res, 100));
		expect(await getTaskStatus(downstream.id)).toBe(TaskStatus.Backlog);

		await setStatus(upstream.id, TaskStatus.InProgress);
		await new Promise((res) => setTimeout(res, 100));

		expect(await getTaskStatus(downstream.id)).toBe(TaskStatus.Blocked);
	});

	it('never coerces an task whose status is already terminal', async () => {
		const upstream = await createTask('inv-term-up', researcherId);
		const downstream = await createTask('inv-term-down', productLeadId);
		await setStatus(downstream.id, TaskStatus.Cancelled);

		await addDependency(downstream.id, upstream.identifier);

		expect(await getTaskStatus(downstream.id)).toBe(TaskStatus.Cancelled);
	});

	it('records a status_change activity event with the derived target', async () => {
		const upstream = await createTask('inv-event-up', researcherId);
		const downstream = await createTask('inv-event-down', productLeadId);
		await addDependency(downstream.id, upstream.identifier);

		const commentsRes = await app.request(`/api/teams/${teamId}/tasks/${downstream.id}/comments`, {
			headers: authHeader(token),
		});
		const comments = (await commentsRes.json()).data as Array<{
			content_type: string;
			content: { kind?: string; from?: string; to?: string };
		}>;
		const ev = comments.find(
			(c) => c.content_type === 'system' && c.content?.kind === 'status_change',
		);
		expect(ev?.content.from).toBe(TaskStatus.Backlog);
		expect(ev?.content.to).toBe(TaskStatus.Blocked);
	});

	it('creates an task directly as blocked when blocked_by_task_ids is provided', async () => {
		const upstream = await createTask('inv-init-up', researcherId);
		const downstream = await createTask('inv-init-down', productLeadId, [upstream.identifier]);

		expect(await getTaskStatus(downstream.id)).toBe(TaskStatus.Blocked);
	});
});

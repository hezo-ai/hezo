import type { PGlite } from '@electric-sql/pglite';
import { TaskStatus, WakeupStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { triggerStatusAutomations } from '../src/services/task-automation';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	projectSlugFor,
} from './helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let architectId: string;
let uiDesignerId: string;
let engineerId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const teamTemplateId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;

	const teamRes = await createTestTeam(db, {
		name: 'Parent Cascade Co',
		template_id: teamTemplateId,
	});
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	const internalProjectSlug = await projectSlugFor(db, teamData.id);

	const projectRes = await createTestProject(db, teamId, {
		name: 'Cascade Project',
		description: 'Test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${internalProjectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	architectId = agents.find((a) => a.slug === 'architect')!.id;
	uiDesignerId = agents.find((a) => a.slug === 'ui-designer')!.id;
	engineerId = agents.find((a) => a.slug === 'engineer')!.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function createTask(
	title: string,
	assigneeId: string,
	parentTaskId?: string,
): Promise<{ id: string; identifier: string }> {
	const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title,
			assignee_id: assigneeId,
			...(parentTaskId ? { parent_task_id: parentTaskId } : {}),
		}),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data;
}

async function clearWakeups(memberId: string): Promise<void> {
	await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [memberId]);
}

async function setStatusDirect(taskId: string, status: string): Promise<void> {
	await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [status, taskId]);
}

async function listWakeups(
	memberId: string,
	taskId: string,
): Promise<
	Array<{
		status: string;
		source: string;
		payload: Record<string, unknown>;
		idempotency_key: string | null;
	}>
> {
	const r = await db.query<{
		status: string;
		source: string;
		payload: Record<string, unknown>;
		idempotency_key: string | null;
	}>(
		`SELECT status::text AS status, source::text AS source, payload, idempotency_key
		 FROM agent_wakeup_requests
		 WHERE member_id = $1 AND payload->>'task_id' = $2
		 ORDER BY created_at ASC`,
		[memberId, taskId],
	);
	return r.rows;
}

describe('parent cascade — sub-task closure wakes parent agent', () => {
	it('wakes parent assignee when the only sub-task transitions to Done', async () => {
		const parent = await createTask('parent solo', architectId);
		const child = await createTask('child solo', uiDesignerId, parent.id);
		await clearWakeups(architectId);

		await setStatusDirect(child.id, TaskStatus.Done);
		await triggerStatusAutomations(
			db,
			teamId,
			child.id,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			undefined,
		);

		const wakeups = await listWakeups(architectId, parent.id);
		const childrenClosed = wakeups.find((w) => w.payload.reason === 'children_closed');
		expect(childrenClosed).toBeDefined();
		expect(childrenClosed?.source).toBe('assignment');
		expect(childrenClosed?.status).toBe(WakeupStatus.Queued);
		expect(childrenClosed?.idempotency_key).toBe(`children-closed:${parent.id}`);
	});

	it('does not wake parent while a sibling sub-task is still open', async () => {
		const parent = await createTask('parent siblings', architectId);
		const childA = await createTask('child A', uiDesignerId, parent.id);
		await createTask('child B still open', engineerId, parent.id);
		await clearWakeups(architectId);

		await setStatusDirect(childA.id, TaskStatus.Done);
		await triggerStatusAutomations(
			db,
			teamId,
			childA.id,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			undefined,
		);

		const wakeups = await listWakeups(architectId, parent.id);
		const childrenClosed = wakeups.find((w) => w.payload.reason === 'children_closed');
		expect(childrenClosed).toBeUndefined();
	});

	it('fires once the final sibling sub-task reaches Done', async () => {
		const parent = await createTask('parent two siblings', architectId);
		const childA = await createTask('first child', uiDesignerId, parent.id);
		const childB = await createTask('second child', engineerId, parent.id);
		await clearWakeups(architectId);

		await setStatusDirect(childA.id, TaskStatus.Done);
		await triggerStatusAutomations(
			db,
			teamId,
			childA.id,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			undefined,
		);
		expect(
			(await listWakeups(architectId, parent.id)).find(
				(w) => w.payload.reason === 'children_closed',
			),
		).toBeUndefined();

		await setStatusDirect(childB.id, TaskStatus.Done);
		await triggerStatusAutomations(
			db,
			teamId,
			childB.id,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			undefined,
		);
		const after = (await listWakeups(architectId, parent.id)).find(
			(w) => w.payload.reason === 'children_closed',
		);
		expect(after).toBeDefined();
	});

	it('cancelled sub-task wakes parent — cancelled counts the same as Done', async () => {
		const parent = await createTask('parent cancel', architectId);
		const child = await createTask('to be cancelled', uiDesignerId, parent.id);
		await clearWakeups(architectId);

		await setStatusDirect(child.id, TaskStatus.Cancelled);
		await triggerStatusAutomations(
			db,
			teamId,
			child.id,
			TaskStatus.Backlog,
			TaskStatus.Cancelled,
			null,
			undefined,
		);

		const wakeups = await listWakeups(architectId, parent.id);
		const childrenClosed = wakeups.find((w) => w.payload.reason === 'children_closed');
		expect(childrenClosed).toBeDefined();
		expect(childrenClosed?.source).toBe('assignment');
		expect(childrenClosed?.idempotency_key).toBe(`children-closed:${parent.id}`);
	});

	it('does not wake parent while a sibling is open even though one sub-task is cancelled', async () => {
		const parent = await createTask('parent cancel + open sibling', architectId);
		const cancelled = await createTask('cancelled child', uiDesignerId, parent.id);
		await createTask('still open child', engineerId, parent.id);
		await clearWakeups(architectId);

		await setStatusDirect(cancelled.id, TaskStatus.Cancelled);
		await triggerStatusAutomations(
			db,
			teamId,
			cancelled.id,
			TaskStatus.Backlog,
			TaskStatus.Cancelled,
			null,
			undefined,
		);

		const wakeups = await listWakeups(architectId, parent.id);
		expect(wakeups.find((w) => w.payload.reason === 'children_closed')).toBeUndefined();
	});

	it('does not wake the parent while a Done child sits beside an open sibling', async () => {
		const parent = await createTask('parent done child', architectId);
		const child = await createTask('child going done', uiDesignerId, parent.id);
		await createTask('still open sibling', engineerId, parent.id);
		await clearWakeups(architectId);

		await setStatusDirect(child.id, TaskStatus.Done);
		await triggerStatusAutomations(
			db,
			teamId,
			child.id,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			undefined,
		);

		const wakeups = await listWakeups(architectId, parent.id);
		expect(wakeups.find((w) => w.payload.reason === 'children_closed')).toBeUndefined();
	});

	it('idempotency key collapses concurrent sibling-close cascades into one queued wakeup', async () => {
		const parent = await createTask('parent idempotent', architectId);
		const childA = await createTask('idem child A', uiDesignerId, parent.id);
		const childB = await createTask('idem child B', engineerId, parent.id);
		await clearWakeups(architectId);

		await setStatusDirect(childA.id, TaskStatus.Done);
		await setStatusDirect(childB.id, TaskStatus.Done);

		await triggerStatusAutomations(
			db,
			teamId,
			childA.id,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			undefined,
		);
		await triggerStatusAutomations(
			db,
			teamId,
			childB.id,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			undefined,
		);

		const matching = (await listWakeups(architectId, parent.id)).filter(
			(w) => w.payload.reason === 'children_closed',
		);
		expect(matching.length).toBe(1);
	});

	it('skips when parent has no assignee', async () => {
		const parent = await createTask('parent no assignee', architectId);
		await db.query('UPDATE tasks SET assignee_id = NULL WHERE id = $1', [parent.id]);
		const child = await createTask('orphan child', uiDesignerId, parent.id);
		await clearWakeups(architectId);

		await setStatusDirect(child.id, TaskStatus.Done);
		await triggerStatusAutomations(
			db,
			teamId,
			child.id,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			undefined,
		);

		const wakeups = await listWakeups(architectId, parent.id);
		expect(wakeups.find((w) => w.payload.reason === 'children_closed')).toBeUndefined();
	});

	it('skips when child has no parent (top-level task close)', async () => {
		const top = await createTask('top-level standalone', architectId);
		await clearWakeups(architectId);

		await setStatusDirect(top.id, TaskStatus.Done);
		await triggerStatusAutomations(
			db,
			teamId,
			top.id,
			TaskStatus.InProgress,
			TaskStatus.Done,
			null,
			undefined,
		);

		const wakeups = await listWakeups(architectId, top.id);
		expect(wakeups.find((w) => w.payload.reason === 'children_closed')).toBeUndefined();
	});
});

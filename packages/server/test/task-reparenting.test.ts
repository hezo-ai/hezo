import { TaskStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectSlug: string;
let agentId: string;

let otherTeamTaskId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Reparent Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, {
		name: 'Reparent Project',
		description: 'Tasks that move around.',
	});
	projectSlug = (await projectRes.json()).data.slug;

	const agentRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Reparent Agent' }),
	});
	agentId = (await agentRes.json()).data.id;

	const otherTeamRes = await createTestTeam(db, { name: 'Bystander Co' });
	const otherTeamId = (await otherTeamRes.json()).data.id;
	const otherProjectRes = await createTestProject(db, otherTeamId, {
		name: 'Bystander Project',
		description: 'Belongs to another team.',
	});
	const otherProjectSlug = (await otherProjectRes.json()).data.slug;
	const stranger = await createTask(otherProjectSlug, 'Stranger task');
	otherTeamTaskId = stranger.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function createTask(
	slug: string,
	title: string,
	parentTaskId?: string,
): Promise<{ id: string; identifier: string }> {
	const res = await app.request(`/api/projects/${slug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title, assignee_id: agentId, parent_task_id: parentTaskId }),
	});
	expect(res.status).toBe(201);
	const data = (await res.json()).data;
	return { id: data.id, identifier: data.identifier };
}

function patch(taskId: string, body: Record<string, unknown>) {
	return app.request(`/api/projects/${projectSlug}/tasks/${taskId}`, {
		method: 'PATCH',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function parentOf(taskId: string): Promise<string | null> {
	const r = await db.query<{ parent_task_id: string | null }>(
		'SELECT parent_task_id FROM tasks WHERE id = $1',
		[taskId],
	);
	return r.rows[0].parent_task_id;
}

async function setStatus(taskId: string, status: TaskStatus): Promise<void> {
	await db.query('UPDATE tasks SET status = $2::task_status WHERE id = $1', [taskId, status]);
}

async function systemComments(taskId: string, kind: string) {
	const r = await db.query<{ content: Record<string, unknown> }>(
		`SELECT content FROM task_comments
		  WHERE task_id = $1 AND content_type = 'system' AND content->>'kind' = $2
		  ORDER BY created_at ASC`,
		[taskId, kind],
	);
	return r.rows.map((row) => row.content);
}

describe('PATCH tasks: promoting to top level', () => {
	it('clears the parent and reports it on the response', async () => {
		const parent = await createTask(projectSlug, 'Parent');
		const child = await createTask(projectSlug, 'Child', parent.id);

		const res = await patch(child.id, { parent_task_id: null });
		expect(res.status).toBe(200);
		expect((await res.json()).data.parent_task_id).toBeNull();
		expect(await parentOf(child.id)).toBeNull();
	});

	// The behaviour that prompted this feature: the parent could not close while
	// the sub-task was open, and cancelling the sub-task was the only escape.
	it('lets the former parent be marked done afterwards', async () => {
		const parent = await createTask(projectSlug, 'Blocked parent');
		const child = await createTask(projectSlug, 'Blocking child', parent.id);

		const blocked = await patch(parent.id, { status: TaskStatus.Done });
		expect(blocked.status).toBe(400);
		expect((await blocked.json()).error.message).toMatch(/sub-task still open/);

		expect((await patch(child.id, { parent_task_id: null })).status).toBe(200);
		expect((await patch(parent.id, { status: TaskStatus.Done })).status).toBe(200);
	});
});

describe('PATCH tasks: nesting under another task', () => {
	it('accepts a task identifier', async () => {
		const newParent = await createTask(projectSlug, 'New parent by identifier');
		const mover = await createTask(projectSlug, 'Mover');

		const res = await patch(mover.id, { parent_task_id: newParent.identifier });
		expect(res.status).toBe(200);
		expect(await parentOf(mover.id)).toBe(newParent.id);
	});

	it('accepts a task UUID', async () => {
		const newParent = await createTask(projectSlug, 'New parent by uuid');
		const mover = await createTask(projectSlug, 'Mover by uuid');

		const res = await patch(mover.id, { parent_task_id: newParent.id });
		expect(res.status).toBe(200);
		expect(await parentOf(mover.id)).toBe(newParent.id);
	});

	it('moves a task from one parent to another', async () => {
		const first = await createTask(projectSlug, 'First parent');
		const second = await createTask(projectSlug, 'Second parent');
		const mover = await createTask(projectSlug, 'Switcher', first.id);

		expect((await patch(mover.id, { parent_task_id: second.id })).status).toBe(200);
		expect(await parentOf(mover.id)).toBe(second.id);
	});
});

describe('PATCH tasks: rejections', () => {
	it('404s an unknown parent identifier', async () => {
		const mover = await createTask(projectSlug, 'Unknown parent mover');
		const res = await patch(mover.id, { parent_task_id: 'ZZ-99999' });
		expect(res.status).toBe(404);
	});

	// `resolveTaskId` passes UUIDs through without a team check, so this is the
	// case that proves the team filter inside the tree walk is doing its job.
	it('404s a parent UUID belonging to another team', async () => {
		const mover = await createTask(projectSlug, 'Cross team mover');
		const res = await patch(mover.id, { parent_task_id: otherTeamTaskId });
		expect(res.status).toBe(404);
		expect(await parentOf(mover.id)).toBeNull();
	});

	it('400s a task naming itself', async () => {
		const mover = await createTask(projectSlug, 'Self parent');
		const res = await patch(mover.id, { parent_task_id: mover.id });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/cannot be its own parent/);
	});

	it('400s nesting a task under its own child', async () => {
		const top = await createTask(projectSlug, 'Cycle top');
		const child = await createTask(projectSlug, 'Cycle child', top.id);

		const res = await patch(top.id, { parent_task_id: child.id });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/one of its own sub-tasks/);
	});

	it('400s nesting a task under its own grandchild', async () => {
		const top = await createTask(projectSlug, 'Deep cycle top');
		const mid = await createTask(projectSlug, 'Deep cycle mid', top.id);
		const leaf = await createTask(projectSlug, 'Deep cycle leaf', mid.id);

		const res = await patch(top.id, { parent_task_id: leaf.id });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/one of its own sub-tasks/);
	});
});

describe('PATCH tasks: the depth cap counts the moving sub-tree', () => {
	it('allows a leaf onto a sub-task', async () => {
		const root = await createTask(projectSlug, 'Depth root A');
		const mid = await createTask(projectSlug, 'Depth mid A', root.id);
		const leaf = await createTask(projectSlug, 'Depth leaf A');

		expect((await patch(leaf.id, { parent_task_id: mid.id })).status).toBe(200);
	});

	it('allows a leaf onto a third-level task', async () => {
		const root = await createTask(projectSlug, 'Depth root B');
		const mid = await createTask(projectSlug, 'Depth mid B', root.id);
		const deep = await createTask(projectSlug, 'Depth deep B', mid.id);
		const leaf = await createTask(projectSlug, 'Depth leaf B');

		expect((await patch(leaf.id, { parent_task_id: deep.id })).status).toBe(200);
	});

	it('rejects a leaf onto a fourth-level task', async () => {
		const root = await createTask(projectSlug, 'Depth root B2');
		const mid = await createTask(projectSlug, 'Depth mid B2', root.id);
		const deep = await createTask(projectSlug, 'Depth deep B2', mid.id);
		const deeper = await createTask(projectSlug, 'Depth deeper B2', deep.id);
		const leaf = await createTask(projectSlug, 'Depth leaf B2');

		const res = await patch(leaf.id, { parent_task_id: deeper.id });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/3 levels deep/);
	});

	it('allows a task carrying children onto a root', async () => {
		const mover = await createTask(projectSlug, 'Subtree mover C');
		await createTask(projectSlug, 'Subtree child C', mover.id);
		const root = await createTask(projectSlug, 'Subtree destination C');

		expect((await patch(mover.id, { parent_task_id: root.id })).status).toBe(200);
	});

	// The case the create-time check alone would wave through: it only ever asks
	// how deep the destination is, because a new task carries nothing.
	it('rejects a task carrying children onto a third-level task', async () => {
		const mover = await createTask(projectSlug, 'Subtree mover D');
		await createTask(projectSlug, 'Subtree child D', mover.id);
		const root = await createTask(projectSlug, 'Subtree root D');
		const mid = await createTask(projectSlug, 'Subtree mid D', root.id);
		const deep = await createTask(projectSlug, 'Subtree deep D', mid.id);

		const res = await patch(mover.id, { parent_task_id: deep.id });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/3 levels deep/);
		expect(await parentOf(mover.id)).toBeNull();
	});

	it('always allows promotion, however tall the sub-tree', async () => {
		const root = await createTask(projectSlug, 'Tall root E');
		const mid = await createTask(projectSlug, 'Tall mid E', root.id);
		await createTask(projectSlug, 'Tall leaf E', mid.id);

		expect((await patch(mid.id, { parent_task_id: null })).status).toBe(200);
		expect(await parentOf(mid.id)).toBeNull();
	});
});

describe('PATCH tasks: closed parents', () => {
	it('rejects an open task under a done parent', async () => {
		const closed = await createTask(projectSlug, 'Closed destination');
		await setStatus(closed.id, TaskStatus.Done);
		const mover = await createTask(projectSlug, 'Open mover');

		const res = await patch(mover.id, { parent_task_id: closed.id });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/already done/);
	});

	it('rejects an open task under a cancelled parent', async () => {
		const closed = await createTask(projectSlug, 'Cancelled destination');
		await setStatus(closed.id, TaskStatus.Cancelled);
		const mover = await createTask(projectSlug, 'Open mover 2');

		const res = await patch(mover.id, { parent_task_id: closed.id });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/already cancelled/);
	});

	it('allows a closed task under a done parent', async () => {
		const closed = await createTask(projectSlug, 'Closed destination 3');
		await setStatus(closed.id, TaskStatus.Done);
		const mover = await createTask(projectSlug, 'Closed mover');
		await setStatus(mover.id, TaskStatus.Done);

		expect((await patch(mover.id, { parent_task_id: closed.id })).status).toBe(200);
	});
});

describe('PATCH tasks: no-ops and field independence', () => {
	it('writes nothing when the parent is unchanged', async () => {
		const parent = await createTask(projectSlug, 'Stable parent');
		const child = await createTask(projectSlug, 'Stable child', parent.id);
		const before = (await systemComments(child.id, 'parent_change')).length;

		const res = await patch(child.id, { parent_task_id: parent.identifier });
		expect(res.status).toBe(200);
		expect(await parentOf(child.id)).toBe(parent.id);
		expect(await systemComments(child.id, 'parent_change')).toHaveLength(before);
	});

	it('writes nothing when a top-level task is promoted again', async () => {
		const task = await createTask(projectSlug, 'Already top level');
		expect((await patch(task.id, { parent_task_id: null })).status).toBe(200);
		expect(await systemComments(task.id, 'parent_change')).toHaveLength(0);
	});

	// The undefined-versus-null distinction: an absent key must not be read as a
	// request to promote.
	it('leaves the parent alone when the field is absent', async () => {
		const parent = await createTask(projectSlug, 'Untouched parent');
		const child = await createTask(projectSlug, 'Untouched child', parent.id);

		expect((await patch(child.id, { title: 'Renamed child' })).status).toBe(200);
		expect(await parentOf(child.id)).toBe(parent.id);
	});
});

describe('PATCH tasks: the move is recorded on the thread', () => {
	it('records a move between two parents', async () => {
		const first = await createTask(projectSlug, 'Record first');
		const second = await createTask(projectSlug, 'Record second');
		const mover = await createTask(projectSlug, 'Recorded mover', first.id);

		await patch(mover.id, { parent_task_id: second.id });

		const [comment] = await systemComments(mover.id, 'parent_change');
		expect(comment).toMatchObject({
			kind: 'parent_change',
			from_id: first.id,
			to_id: second.id,
			from_identifier: first.identifier,
			to_identifier: second.identifier,
		});
		expect(comment.text).toMatch(
			new RegExp(`moved this task from ${first.identifier} to ${second.identifier}`),
		);
	});

	it('records a promotion', async () => {
		const parent = await createTask(projectSlug, 'Promotion parent');
		const child = await createTask(projectSlug, 'Promoted child', parent.id);

		await patch(child.id, { parent_task_id: null });

		const [comment] = await systemComments(child.id, 'parent_change');
		expect(comment).toMatchObject({ from_id: parent.id, to_id: null });
		expect(comment.text).toMatch(
			new RegExp(`promoted this task to top level \\(was under ${parent.identifier}\\)`),
		);
	});

	it('records a first nesting', async () => {
		const parent = await createTask(projectSlug, 'Nesting parent');
		const mover = await createTask(projectSlug, 'Newly nested');

		await patch(mover.id, { parent_task_id: parent.id });

		const [comment] = await systemComments(mover.id, 'parent_change');
		expect(comment).toMatchObject({ from_id: null, to_id: parent.id });
		expect(comment.text).toMatch(new RegExp(`nested this task under ${parent.identifier}`));
	});
});

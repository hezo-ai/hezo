import { TaskStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/database';
import {
	assertChildDepthAllowed,
	measureParentPlacement,
	resolveParentAssignment,
	SUB_TASK_DEPTH_ERROR,
} from '../src/lib/task-relationships';
import { safeClose } from './helpers';
import { createTestApp, createTestProject, createTestTeam } from './helpers/app';

let db: Db;
let teamId: string;
let projectId: string;

// A second team, used to prove the cross-team hole in `resolveTaskId` is closed.
let otherTeamId: string;
let otherProjectId: string;
let otherTeamTaskId: string;

// `projects` carries a UNIQUE index on team_id, so one team owns exactly one
// project and a legitimate same-team/different-project parent cannot exist.
// `tasks.project_id` is not FK-tied to the team's project though, so a row can
// still point somewhere else - which is the only way the same-project check can
// ever fire, and why it is worth keeping.
let strayProjectTaskId: string;

/** Tree under test:  A -> B -> C,  plus roots D and E. */
const ids: Record<string, string> = {};

// Project creation seeds its own planning task, so start well clear of it:
// `tasks` carries UNIQUE (project_id, number).
let nextNumber = 5000;

async function seedTask(opts: {
	key: string;
	parent?: string;
	status?: TaskStatus;
	team?: string;
	project?: string;
}): Promise<string> {
	const team = opts.team ?? teamId;
	const project = opts.project ?? projectId;
	const number = nextNumber++;
	const r = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, parent_task_id, number, identifier, title, status)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::task_status)
		 RETURNING id`,
		[
			team,
			project,
			opts.parent ? (ids[opts.parent] ?? opts.parent) : null,
			number,
			`TR-${number}`,
			`Task ${opts.key}`,
			opts.status ?? TaskStatus.Backlog,
		],
	);
	ids[opts.key] = r.rows[0].id;
	return r.rows[0].id;
}

function subject(key: string, overrides: Partial<{ status: string; projectId: string }> = {}) {
	return {
		taskId: ids[key],
		projectId: overrides.projectId ?? projectId,
		currentParentTaskId: null,
		status: overrides.status ?? TaskStatus.Backlog,
	};
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;

	const teamRes = await createTestTeam(db, { name: 'Hierarchy Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, {
		name: 'Tree Project',
		description: 'Tasks under test.',
	});
	projectId = (await projectRes.json()).data.id;

	const otherTeamRes = await createTestTeam(db, { name: 'Other Co' });
	otherTeamId = (await otherTeamRes.json()).data.id;
	const otherProjectRes = await createTestProject(db, otherTeamId, {
		name: 'Other Project',
		description: 'Belongs to a different team.',
	});
	otherProjectId = (await otherProjectRes.json()).data.id;

	//  A            D (root, leaf)
	//  └─ B         E (root, leaf)
	//     └─ C
	await seedTask({ key: 'A' });
	await seedTask({ key: 'B', parent: 'A' });
	await seedTask({ key: 'C', parent: 'B' });
	await seedTask({ key: 'D' });
	await seedTask({ key: 'E' });
	await seedTask({ key: 'DONE_ROOT', status: TaskStatus.Done });
	await seedTask({ key: 'CANCELLED_ROOT', status: TaskStatus.Cancelled });
	await seedTask({ key: 'CLOSED_MOVER', status: TaskStatus.Done });

	// In this team, but pointing at another team's project.
	strayProjectTaskId = await seedTask({ key: 'STRAY_PROJECT', project: otherProjectId });

	otherTeamTaskId = await seedTask({
		key: 'OTHER_TEAM_ROOT',
		team: otherTeamId,
		project: otherProjectId,
	});
});

afterAll(async () => {
	await safeClose(db);
});

describe('measureParentPlacement', () => {
	it('measures depth of a root, a child and a grandchild', async () => {
		const root = await measureParentPlacement(db, teamId, ids.A, null);
		const child = await measureParentPlacement(db, teamId, ids.B, null);
		const grandchild = await measureParentPlacement(db, teamId, ids.C, null);

		expect(root.parentDepth).toBe(0);
		expect(child.parentDepth).toBe(1);
		expect(grandchild.parentDepth).toBe(2);
	});

	it('measures height of a leaf, a parent and a grandparent', async () => {
		const leaf = await measureParentPlacement(db, teamId, ids.D, ids.C);
		const parent = await measureParentPlacement(db, teamId, ids.D, ids.B);
		const grandparent = await measureParentPlacement(db, teamId, ids.D, ids.A);

		expect(leaf.movingHeight).toBe(0);
		expect(parent.movingHeight).toBe(1);
		expect(grandparent.movingHeight).toBe(2);
	});

	it('reports the proposed parent as inside the moving sub-tree for self, child and grandchild', async () => {
		const self = await measureParentPlacement(db, teamId, ids.A, ids.A);
		const child = await measureParentPlacement(db, teamId, ids.B, ids.A);
		const grandchild = await measureParentPlacement(db, teamId, ids.C, ids.A);

		expect(self.parentInMovingSubtree).toBe(true);
		expect(child.parentInMovingSubtree).toBe(true);
		expect(grandchild.parentInMovingSubtree).toBe(true);
	});

	it('does not report an unrelated task as inside the moving sub-tree', async () => {
		const placement = await measureParentPlacement(db, teamId, ids.D, ids.A);
		expect(placement.parentInMovingSubtree).toBe(false);
	});

	it('returns no height and no overlap when there is no moving task (the create path)', async () => {
		const placement = await measureParentPlacement(db, teamId, ids.B, null);
		expect(placement.movingHeight).toBe(0);
		expect(placement.parentInMovingSubtree).toBe(false);
		expect(placement.parentFound).toBe(true);
	});

	it('carries the parent project, identifier and status', async () => {
		const placement = await measureParentPlacement(db, teamId, ids.DONE_ROOT, null);
		expect(placement.parentProjectId).toBe(projectId);
		expect(placement.parentIdentifier).toMatch(/^TR-\d+$/);
		expect(placement.parentStatus).toBe(TaskStatus.Done);
	});

	// `resolveTaskId` passes any well-formed UUID straight through without a team
	// check, so this walk is the only thing standing between a foreign task id and
	// a cross-team re-parent.
	it('does not find a task belonging to another team', async () => {
		const placement = await measureParentPlacement(db, teamId, otherTeamTaskId, null);
		expect(placement.parentFound).toBe(false);
	});

	it('does not find an unknown id', async () => {
		const placement = await measureParentPlacement(
			db,
			teamId,
			'00000000-0000-4000-8000-000000000000',
			null,
		);
		expect(placement.parentFound).toBe(false);
	});
});

// The create path must behave exactly as it did before the depth rule was
// extracted, so these assert the messages verbatim.
describe('assertChildDepthAllowed (create path, unchanged behaviour)', () => {
	it('allows a root as parent', async () => {
		expect(await assertChildDepthAllowed(db, teamId, ids.A)).toEqual({ ok: true });
	});

	it('allows a child as parent', async () => {
		expect(await assertChildDepthAllowed(db, teamId, ids.B)).toEqual({ ok: true });
	});

	it('rejects a grandchild as parent', async () => {
		const check = await assertChildDepthAllowed(db, teamId, ids.C);
		expect(check).toEqual({ ok: false, message: SUB_TASK_DEPTH_ERROR });
	});

	it('reports a missing parent', async () => {
		const check = await assertChildDepthAllowed(db, teamId, '00000000-0000-4000-8000-000000000000');
		expect(check).toEqual({ ok: false, message: 'Parent task not found' });
	});
});

describe('resolveParentAssignment: promotion', () => {
	it('promotes a sub-task without touching the database', async () => {
		const spy = vi.spyOn(db, 'query');
		const result = await resolveParentAssignment(
			db,
			teamId,
			{
				...subject('C'),
				currentParentTaskId: ids.B,
			},
			null,
		);
		expect(result).toEqual({ ok: true, parentTaskId: null, changed: true });
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it('treats an empty string as a promotion', async () => {
		const result = await resolveParentAssignment(
			db,
			teamId,
			{
				...subject('C'),
				currentParentTaskId: ids.B,
			},
			'',
		);
		expect(result).toEqual({ ok: true, parentTaskId: null, changed: true });
	});

	it('reports no change when the task is already top level', async () => {
		const result = await resolveParentAssignment(db, teamId, subject('D'), null);
		expect(result).toEqual({ ok: true, parentTaskId: null, changed: false });
	});
});

describe('resolveParentAssignment: identity', () => {
	it('resolves an identifier to a task id', async () => {
		const identifier = (
			await db.query<{ identifier: string }>('SELECT identifier FROM tasks WHERE id = $1', [ids.D])
		).rows[0].identifier;
		const result = await resolveParentAssignment(db, teamId, subject('E'), identifier);
		expect(result).toEqual({ ok: true, parentTaskId: ids.D, changed: true });
	});

	it('rejects an unknown identifier', async () => {
		const result = await resolveParentAssignment(db, teamId, subject('E'), 'TR-99999');
		expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
	});

	it("rejects another team's task id", async () => {
		const result = await resolveParentAssignment(db, teamId, subject('E'), otherTeamTaskId);
		expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
	});

	it('rejects a task naming itself', async () => {
		const result = await resolveParentAssignment(db, teamId, subject('E'), ids.E);
		expect(result).toMatchObject({
			ok: false,
			code: 'INVALID_REQUEST',
			message: 'A task cannot be its own parent',
		});
	});

	it('reports no change when the parent is already set to that task', async () => {
		const result = await resolveParentAssignment(
			db,
			teamId,
			{ ...subject('C'), currentParentTaskId: ids.B },
			ids.B,
		);
		expect(result).toEqual({ ok: true, parentTaskId: ids.B, changed: false });
	});

	it('rejects a parent belonging to a different project', async () => {
		const result = await resolveParentAssignment(db, teamId, subject('E'), strayProjectTaskId);
		expect(result).toMatchObject({
			ok: false,
			code: 'INVALID_REQUEST',
			message: 'Parent task must be in the same project',
		});
	});
});

describe('resolveParentAssignment: cycles', () => {
	it('rejects nesting a task under its own child', async () => {
		const result = await resolveParentAssignment(db, teamId, subject('A'), ids.B);
		expect(result).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
		expect((result as { message: string }).message).toMatch(/one of its own sub-tasks/);
	});

	it('rejects nesting a task under its own grandchild', async () => {
		const result = await resolveParentAssignment(db, teamId, subject('A'), ids.C);
		expect(result).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
		expect((result as { message: string }).message).toMatch(/one of its own sub-tasks/);
	});
});

// The whole point of the shared rule: the create-time check only ever asked how
// deep the destination sat, because a new task carries nothing. These are the
// rows of the legality table.
describe('resolveParentAssignment: depth with the moving sub-tree', () => {
	it('allows a leaf onto a root (0 + 1 + 0)', async () => {
		const result = await resolveParentAssignment(db, teamId, subject('E'), ids.D);
		expect(result).toMatchObject({ ok: true, changed: true });
	});

	it('allows a leaf onto a child (1 + 1 + 0)', async () => {
		const result = await resolveParentAssignment(db, teamId, subject('E'), ids.B);
		expect(result).toMatchObject({ ok: true, changed: true });
	});

	it('rejects a leaf onto a grandchild (2 + 1 + 0)', async () => {
		const result = await resolveParentAssignment(db, teamId, subject('E'), ids.C);
		expect(result).toMatchObject({
			ok: false,
			code: 'INVALID_REQUEST',
			message: SUB_TASK_DEPTH_ERROR,
		});
	});

	it('allows a task with children onto a root (0 + 1 + 1)', async () => {
		const result = await resolveParentAssignment(
			db,
			teamId,
			{ ...subject('B'), currentParentTaskId: ids.A },
			ids.D,
		);
		expect(result).toMatchObject({ ok: true, changed: true });
	});

	it('rejects a task with children onto a child (1 + 1 + 1)', async () => {
		// D gains a child so it becomes a legal depth-1 destination that still
		// cannot take a sub-tree.
		await seedTask({ key: 'D_CHILD', parent: 'D' });
		const result = await resolveParentAssignment(
			db,
			teamId,
			{ ...subject('B'), currentParentTaskId: ids.A },
			ids.D_CHILD,
		);
		expect(result).toMatchObject({
			ok: false,
			code: 'INVALID_REQUEST',
			message: SUB_TASK_DEPTH_ERROR,
		});
	});

	it('rejects a task with grandchildren onto any parent', async () => {
		const result = await resolveParentAssignment(db, teamId, subject('A'), ids.D);
		expect(result).toMatchObject({
			ok: false,
			code: 'INVALID_REQUEST',
			message: SUB_TASK_DEPTH_ERROR,
		});
	});
});

describe('resolveParentAssignment: closed parents', () => {
	it('rejects an open task under a done parent', async () => {
		const result = await resolveParentAssignment(db, teamId, subject('E'), ids.DONE_ROOT);
		expect(result).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
		expect((result as { message: string }).message).toMatch(/already done/);
	});

	it('rejects an open task under a cancelled parent', async () => {
		const result = await resolveParentAssignment(db, teamId, subject('E'), ids.CANCELLED_ROOT);
		expect(result).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
		expect((result as { message: string }).message).toMatch(/already cancelled/);
	});

	// The rule protects the close gate, which only cares about open children.
	it('allows a closed task under a done parent', async () => {
		const result = await resolveParentAssignment(
			db,
			teamId,
			{ ...subject('CLOSED_MOVER'), status: TaskStatus.Done },
			ids.DONE_ROOT,
		);
		expect(result).toMatchObject({ ok: true, changed: true });
	});
});

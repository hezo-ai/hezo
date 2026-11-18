// Git work on a clone serializes per clone store: the project when a backend
// shares one workspace across a project's containers, the container when each
// has its own disk. A lock per project on the second kind only made fresh
// containers clone one after another.

import { SandboxBackend } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { type RepoStore, repoStoreKey, withRepoStoreLock } from '../src/lib/git-lock';
import { setStoredSandboxBackend } from '../src/services/sandbox/backend-store';
import { otherRunsSharingStore, repoStoreFor } from '../src/services/sandbox/repo-store';
import { safeClose } from './helpers';
import { createTestDbWithMigrations } from './helpers/db';

/** Run two holders and report whether the second entered before the first left. */
async function overlapped(a: RepoStore, b: RepoStore): Promise<boolean> {
	let firstInside = false;
	let overlap = false;
	let releaseFirst!: () => void;
	const firstHeld = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let entered!: () => void;
	const firstEntered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const first = withRepoStoreLock(a, async () => {
		firstInside = true;
		entered();
		await firstHeld;
		firstInside = false;
	});
	await firstEntered;
	const second = withRepoStoreLock(b, async () => {
		overlap = firstInside;
	});
	// Give the second holder its chance to enter while the first still holds.
	await new Promise((resolve) => setTimeout(resolve, 20));
	releaseFirst();
	await Promise.all([first, second]);
	return overlap;
}

describe('withRepoStoreLock', () => {
	it('lets two containers with their own disks work in parallel', async () => {
		const a = { projectId: 'p1', containerId: 'c1', sharedAcrossContainers: false };
		const b = { projectId: 'p1', containerId: 'c2', sharedAcrossContainers: false };
		expect(repoStoreKey(a)).not.toBe(repoStoreKey(b));
		expect(await overlapped(a, b)).toBe(true);
	});

	it('serializes two containers that share the project workspace', async () => {
		const a = { projectId: 'p2', containerId: 'c1', sharedAcrossContainers: true };
		const b = { projectId: 'p2', containerId: 'c2', sharedAcrossContainers: true };
		expect(repoStoreKey(a)).toBe(repoStoreKey(b));
		expect(await overlapped(a, b)).toBe(false);
	});
});

describe('repoStoreFor', () => {
	let db: Db;

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('reads the store from the backend kind', async () => {
		await setStoredSandboxBackend(db, SandboxBackend.Docker);
		expect((await repoStoreFor(db, 'p3', 'c1')).sharedAcrossContainers).toBe(true);

		await setStoredSandboxBackend(db, SandboxBackend.Daytona);
		expect((await repoStoreFor(db, 'p3', 'c1')).sharedAcrossContainers).toBe(false);
	});
});

// The store lock covers prep only, so another run's agent can be committing in a
// shared clone while this run prepares. Prep asks this before starting cleanup.
describe('otherRunsSharingStore', () => {
	let db: Db;
	let projectId: string;
	let teamId: string;
	let memberId: string;
	let taskA: string;
	let taskB: string;
	let otherProjectTask: string;
	let otherTeamId: string;
	let otherMemberId: string;

	async function seedProject(slug: string, prefix: string) {
		const team = await db.query<{ id: string }>(
			'INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id',
			[`team-${slug}`],
		);
		const project = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, $2, $2, $3) RETURNING id`,
			[team.rows[0].id, slug, prefix],
		);
		const member = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Worker') RETURNING id`,
			[team.rows[0].id],
		);
		return { teamId: team.rows[0].id, projectId: project.rows[0].id, memberId: member.rows[0].id };
	}
	async function seedTask(team: string, project: string, n: number, identifier: string) {
		const r = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority)
			 VALUES ($1, $2, $3, $4, $4, 'in_progress'::task_status, 'medium') RETURNING id`,
			[team, project, n, identifier],
		);
		return r.rows[0].id;
	}
	async function seedRun(
		member: string,
		team: string,
		task: string | null,
		status: 'queued' | 'running' | 'succeeded',
	) {
		const r = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status) RETURNING id`,
			[member, team, task, status],
		);
		return r.rows[0].id;
	}
	const shared = (): RepoStore => ({ projectId, containerId: 'c1', sharedAcrossContainers: true });

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
		({ teamId, projectId, memberId } = await seedProject('shr', 'SHR'));
		taskA = await seedTask(teamId, projectId, 1, 'SHR-1');
		taskB = await seedTask(teamId, projectId, 2, 'SHR-2');
		const other = await seedProject('oth', 'OTH');
		otherTeamId = other.teamId;
		otherMemberId = other.memberId;
		otherProjectTask = await seedTask(other.teamId, other.projectId, 1, 'OTH-1');
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('answers the active runs of the project, leaving out the caller and anything finished', async () => {
		const self = await seedRun(memberId, teamId, taskA, 'running');
		// Queued counts: its agent starts at any moment.
		await seedRun(memberId, teamId, taskB, 'queued');
		await seedRun(memberId, teamId, taskB, 'succeeded');
		await seedRun(otherMemberId, otherTeamId, otherProjectTask, 'running');
		try {
			expect(await otherRunsSharingStore(db, shared(), self)).toEqual([{ task_id: taskB }]);
		} finally {
			await db.query('DELETE FROM heartbeat_runs');
		}
	});

	it('counts a task-less run on the project, which works in the same clones', async () => {
		const self = await seedRun(memberId, teamId, taskA, 'running');
		await seedRun(memberId, teamId, null, 'running');
		try {
			expect(await otherRunsSharingStore(db, shared(), self)).toEqual([{ task_id: null }]);
		} finally {
			await db.query('DELETE FROM heartbeat_runs');
		}
	});

	it("answers none for a store on one container's own disk", async () => {
		const self = await seedRun(memberId, teamId, taskA, 'running');
		await seedRun(memberId, teamId, taskB, 'running');
		try {
			const own = { ...shared(), sharedAcrossContainers: false };
			expect(await otherRunsSharingStore(db, own, self)).toEqual([]);
		} finally {
			await db.query('DELETE FROM heartbeat_runs');
		}
	});
});

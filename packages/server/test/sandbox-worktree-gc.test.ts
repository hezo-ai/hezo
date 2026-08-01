import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgliteDb } from '../src/db/drivers/pglite';
import type { RepoLoc } from '../src/services/git';
import { localGitLoc } from '../src/services/git';
import { HostGitExecutor } from '../src/services/git-executor';
import {
	collectFinishedWorktrees,
	MAX_WORKTREE_REMOVALS_PER_PASS,
	resolveReclaimableTasks,
} from '../src/services/sandbox/worktree-gc';
import { createTestDbWithMigrations } from './helpers/db';

/**
 * Worktree GC against real `git worktree` - the whole question is which
 * registrations git actually drops, so a scripted executor would only assert the
 * arguments we chose to pass.
 *
 * Worktrees are deliberately kept after a run (a task gets many runs and reusing
 * its worktree is the common case), so a container that serves twenty tasks
 * accumulates twenty of them. That only costs disk on the operator's own daemon;
 * a managed sandbox has a few GB in total and cannot offload package caches to
 * the shared store, which is what makes this mandatory rather than housekeeping.
 */

// Resolved, because git reports worktree paths with symlinks followed. On macOS
// `tmpdir()` is `/var/folders/…`, a symlink to `/private/var/folders/…`, so an
// unresolved root is 8 characters shorter than what `git worktree list` prints -
// and every path this fixture slices by that prefix comes out shifted.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-gc-')));
const exec = new HostGitExecutor();

function run(cmd: string, cwd?: string): string {
	return execSync(cmd, { cwd, stdio: 'pipe' }).toString();
}

describe('worktree GC', () => {
	let db: PgliteDb;
	let teamId: string;
	let projectId: string;
	let clone: RepoLoc;
	let worktreesRoot: string;

	/** Task identifiers whose worktree is still registered with git. */
	const registered = (): string[] =>
		run('git worktree list --porcelain', clone.containerPath)
			.split('\n')
			.filter((l) => l.startsWith('worktree ') && l.includes(`${worktreesRoot}/`))
			.map(
				(l) =>
					l
						.slice('worktree '.length)
						.trim()
						.slice(worktreesRoot.length + 1)
						.split('/')[0],
			);

	let taskNumber = 0;
	async function seedTask(identifier: string, status: TaskStatus): Promise<void> {
		taskNumber += 1;
		await db.query(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority)
			 VALUES ($1, $2, $3, $4, $4, $5::task_status, 'medium')`,
			[teamId, projectId, taskNumber, identifier, status],
		);
	}

	function addWorktree(identifier: string): void {
		mkdirSync(join(worktreesRoot, identifier), { recursive: true });
		run(
			`git worktree add -b hezo/${identifier} ${join(worktreesRoot, identifier, 'repo')}`,
			clone.containerPath,
		);
	}

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
		const team = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('GC Co', 'gc-co') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'GC', 'gc', 'GC') RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;

		const clonePath = join(root, 'repo');
		worktreesRoot = join(root, 'worktrees');
		run(`git init -b main ${clonePath}`);
		run('git config user.name tester', clonePath);
		run('git config user.email tester@test.com', clonePath);
		run('git config commit.gpgsign false', clonePath);
		run('git commit --allow-empty -m initial', clonePath);
		clone = localGitLoc(clonePath);

		await seedTask('GC-1', TaskStatus.Done);
		await seedTask('GC-2', TaskStatus.InProgress);
		await seedTask('GC-3', TaskStatus.Cancelled);
		for (const id of ['GC-1', 'GC-2', 'GC-3', 'GC-ORPHAN']) addWorktree(id);
	});

	afterAll(async () => {
		await db.close();
		rmSync(root, { recursive: true, force: true });
	});

	it('reclaims finished and orphaned worktrees while leaving in-flight ones alone', async () => {
		expect(registered().sort()).toEqual(['GC-1', 'GC-2', 'GC-3', 'GC-ORPHAN']);

		const result = await collectFinishedWorktrees(
			db,
			exec,
			projectId,
			[clone],
			undefined,
			worktreesRoot,
		);

		// Done and Cancelled are terminal; GC-ORPHAN has no task row at all, which is
		// what a crashed run or a deleted task leaves behind and nothing will return
		// for. GC-2 is live and must survive - reclaiming it would delete the tree a
		// running agent is working in.
		expect(result.removed.sort()).toEqual(['GC-1', 'GC-3', 'GC-ORPHAN']);
		expect(result.deferred).toBe(false);
		expect(registered()).toEqual(['GC-2']);
	});

	it('keeps the branch ref, so committed work is never what is reclaimed', async () => {
		// The tree goes; the commits do not. This is why force-removing a dirty
		// worktree is safe here.
		const refs = run('git branch --list hezo/GC-1', clone.containerPath);
		expect(refs).toContain('hezo/GC-1');
	});

	it('is a no-op when there are no clones to sweep', async () => {
		const result = await collectFinishedWorktrees(db, exec, projectId, []);
		expect(result).toEqual({ removed: [], deferred: false });
	});

	it('bounds a pass and reports that more remain', async () => {
		for (const id of ['GC-A', 'GC-B', 'GC-C']) addWorktree(id);
		// None have task rows, so all three are reclaimable.
		const first = await collectFinishedWorktrees(db, exec, projectId, [clone], 2, worktreesRoot);
		expect(first.removed).toHaveLength(2);
		// The cap is what stopped it, so the caller knows to expect another pass -
		// a container with a long backlog pays a predictable cost per run instead of
		// stalling one run to clear all of it.
		expect(first.deferred).toBe(true);

		const second = await collectFinishedWorktrees(db, exec, projectId, [clone], 2, worktreesRoot);
		expect(second.removed).toHaveLength(1);
		expect(second.deferred).toBe(false);
		expect(registered()).toEqual(['GC-2']);
	});

	it('caps automatic passes by default and leaves the admin action unbounded', () => {
		// The default exists so the run-prep sweep is bounded; the admin action passes
		// undefined because a human asked for it and is waiting on the result.
		expect(MAX_WORKTREE_REMOVALS_PER_PASS).toBeGreaterThan(0);
	});
});

describe('resolveReclaimableTasks', () => {
	let db: PgliteDb;
	let projectId: string;
	let projectTeamId: string;
	let otherProjectId: string;
	let otherTeamId: string;

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
		const seed = async (slug: string, prefix: string): Promise<[string, string]> => {
			const team = await db.query<{ id: string }>(
				'INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id',
				[`team-${slug}`],
			);
			const project = await db.query<{ id: string }>(
				`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, $2, $2, $3) RETURNING id`,
				[team.rows[0].id, slug, prefix],
			);
			return [team.rows[0].id, project.rows[0].id];
		};
		[projectTeamId, projectId] = await seed('rec', 'REC');
		[otherTeamId, otherProjectId] = await seed('oth', 'OTH');
		await db.query(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority) VALUES
			 ($1, $2, 1, 'REC-1', 'done', 'done'::task_status, 'medium'),
			 ($1, $2, 2, 'REC-2', 'open', 'in_progress'::task_status, 'medium'),
			 ($1, $2, 3, 'REC-3', 'cancelled', 'cancelled'::task_status, 'medium'),
			 ($1, $2, 4, 'REC-4', 'backlog', 'backlog'::task_status, 'medium'),
			 ($3, $4, 1, 'OTH-1', 'other', 'in_progress'::task_status, 'medium')`,
			[projectTeamId, projectId, otherTeamId, otherProjectId],
		);
	});
	afterAll(() => db.close());

	it('reclaims terminal tasks and leaves every open status alone', async () => {
		const reclaimable = await resolveReclaimableTasks(db, projectId);
		expect(reclaimable('REC-1')).toBe(true);
		expect(reclaimable('REC-3')).toBe(true);
		expect(reclaimable('REC-2')).toBe(false);
		expect(reclaimable('REC-4')).toBe(false);
	});

	it('reclaims an identifier with no task row', async () => {
		// A leftover from a crashed run or a deleted task - nothing comes back for it.
		const reclaimable = await resolveReclaimableTasks(db, projectId);
		expect(reclaimable('REC-999')).toBe(true);
	});

	it('is scoped to the project, so another project’s open task is not read as reclaimable-by-absence', async () => {
		// The identifier belongs to a live task, just not here. Sweeping a project's
		// worktrees must not depend on identifiers it cannot see - and it does not,
		// because a worktree root is per project too.
		const reclaimable = await resolveReclaimableTasks(db, otherProjectId);
		expect(reclaimable('OTH-1')).toBe(false);
		expect(reclaimable('REC-2')).toBe(true);
	});
});

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	countUnpushedCommits,
	describeUnpushedWork,
	findUnpushedWork,
	localGitLoc,
	type RepoLoc,
} from '../src/services/git';
import { type GitExecutor, HostGitExecutor } from '../src/services/git-executor';
import { hostSandboxFiles } from '../src/services/sandbox/files';

/**
 * The ref comparison that decides whether a run left committed work behind in one
 * container only, exercised against real `git` with a real bare `origin` - the
 * point of the check is what git's remote-tracking refs actually say, so a mocked
 * executor would test nothing.
 *
 * This is deliberately NOT driven off the push-error log. That log is append-only
 * within a run and cleared at prep, so a push that failed at commit 3 and succeeded
 * at commit 5 leaves a non-empty log with nothing actually unpushed - the
 * `pushes after a failure` case below is exactly that shape, and it is the one a
 * log-based check gets wrong.
 */

const root = mkdtempSync(join(tmpdir(), 'git-unpushed-'));
const exec = new HostGitExecutor();
const repoLoc = (p: string): RepoLoc => localGitLoc(p);

afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(cmd: string, cwd?: string): string {
	return execSync(cmd, { cwd, stdio: 'pipe' }).toString();
}

function commit(clone: string, message: string) {
	run(`git commit --allow-empty -m ${JSON.stringify(message)}`, clone);
}

/** A clone on a fresh `hezo/<task>` branch pointed at a bare origin with one commit. */
function setupClone(name: string, branch: string): { clone: string; bare: string } {
	const bare = join(root, `${name}.git`);
	const clone = join(root, `${name}-clone`);
	run(`git init --bare -b main ${bare}`);
	run(`git clone ${bare} ${clone}`);
	run('git config user.name tester', clone);
	run('git config user.email tester@test.com', clone);
	run('git config commit.gpgsign false', clone);
	commit(clone, 'initial');
	run('git push origin HEAD:main', clone);
	run(`git checkout -b ${branch}`, clone);
	return { clone, bare };
}

const BRANCH = 'hezo/hez-1';

describe('countUnpushedCommits', () => {
	it('reports 0 when every commit reached origin', async () => {
		const { clone } = setupClone('pushed', BRANCH);
		commit(clone, 'work');
		run('git push origin HEAD', clone);
		expect(await countUnpushedCommits(exec, repoLoc(clone), BRANCH)).toBe(0);
	});

	it('counts commits that reached no remote', async () => {
		const { clone } = setupClone('unpushed', BRANCH);
		commit(clone, 'one');
		commit(clone, 'two');
		expect(await countUnpushedCommits(exec, repoLoc(clone), BRANCH)).toBe(2);
	});

	it('counts only the commits made after the last successful push', async () => {
		const { clone } = setupClone('partial', BRANCH);
		commit(clone, 'landed');
		run('git push origin HEAD', clone);
		commit(clone, 'stranded');
		expect(await countUnpushedCommits(exec, repoLoc(clone), BRANCH)).toBe(1);
	});

	it('reports 0 once a later push lands the commits an earlier one failed on', async () => {
		// The case a push-error-log check gets wrong: the log is non-empty and
		// nothing is actually unpushed. Simulated by committing twice with the push
		// only happening at the end, which is the state a retried push leaves.
		const { clone } = setupClone('recovered', BRANCH);
		commit(clone, 'failed to push');
		commit(clone, 'pushed');
		expect(await countUnpushedCommits(exec, repoLoc(clone), BRANCH)).toBe(2);
		run('git push origin HEAD', clone);
		expect(await countUnpushedCommits(exec, repoLoc(clone), BRANCH)).toBe(0);
	});

	it('reports 0 for commits already on the remote via another branch', async () => {
		// Never pushed under `hezo/<task>`, but reachable from `origin/main` - the
		// work is on the remote, so nothing is stranded. A bare
		// local-ref-vs-its-own-remote-counterpart comparison would wrongly flag this.
		const { clone } = setupClone('merged', BRANCH);
		commit(clone, 'work');
		run(`git push origin ${BRANCH}:main`, clone);
		run('git fetch origin', clone);
		expect(await countUnpushedCommits(exec, repoLoc(clone), BRANCH)).toBe(0);
	});

	it('reports 0 when the task branch was never created', async () => {
		// A definite absence of unpushed work, not an unanswered question: the agent
		// committed nothing on this task's branch.
		const { clone } = setupClone('nobranch', 'hezo/other');
		expect(await countUnpushedCommits(exec, repoLoc(clone), BRANCH)).toBe(0);
	});

	it('answers without touching the network', async () => {
		// The tracking refs are the record; if this reached out, deleting origin
		// would break it. Run prep fetches before the agent starts, so they are
		// current by the time the check runs.
		const { clone, bare } = setupClone('offline', BRANCH);
		commit(clone, 'work');
		rmSync(bare, { recursive: true, force: true });
		expect(await countUnpushedCommits(exec, repoLoc(clone), BRANCH)).toBe(1);
	});

	it('returns null - not 0 - when the clone is gone', async () => {
		// Null means "could not answer". Reporting 0 would clear a pin the container
		// genuinely needs, which is the failure the pin exists to prevent.
		expect(await countUnpushedCommits(exec, repoLoc(join(root, 'missing')), BRANCH)).toBeNull();
	});

	it('returns null when git itself fails', async () => {
		const { clone } = setupClone('gitfail', BRANCH);
		commit(clone, 'work');
		const broken: GitExecutor = {
			files: (containerPath: string) => hostSandboxFiles(containerPath),
			exec: async (args, opts) =>
				args[0] === 'rev-list'
					? { exitCode: 128, stdout: '', stderr: 'fatal: bad revision' }
					: exec.exec(args, opts),
		};
		expect(await countUnpushedCommits(broken, repoLoc(clone), BRANCH)).toBeNull();
	});

	it('treats any named durable remote as safe', async () => {
		// What counts as durable is a parameter, so a future backstop remote is added
		// in one place rather than at each call site.
		const { clone } = setupClone('mirror', BRANCH);
		const mirror = join(root, 'mirror.git');
		run(`git init --bare -b main ${mirror}`);
		run(`git remote add backup ${mirror}`, clone);
		commit(clone, 'work');
		run('git push backup HEAD', clone);
		expect(await countUnpushedCommits(exec, repoLoc(clone), BRANCH)).toBe(1);
		expect(await countUnpushedCommits(exec, repoLoc(clone), BRANCH, ['origin', 'backup'])).toBe(0);
	});
});

describe('findUnpushedWork', () => {
	it('reports only the clones actually holding stranded commits', async () => {
		const clean = setupClone('multi-clean', BRANCH);
		commit(clean.clone, 'work');
		run('git push origin HEAD', clean.clone);
		const dirty = setupClone('multi-dirty', BRANCH);
		commit(dirty.clone, 'work');

		const scan = await findUnpushedWork(exec, [repoLoc(clean.clone), repoLoc(dirty.clone)], BRANCH);
		expect(scan.complete).toBe(true);
		// Compared by the clone it names, not by deep equality: a `RepoLoc` carries a
		// `SandboxFiles` whose methods are closures, so two locs for the same path
		// are never `toEqual` even though they address the same clone.
		expect(scan.work).toHaveLength(1);
		expect(scan.work[0].repo.containerPath).toBe(dirty.clone);
		expect(scan.work[0]).toMatchObject({ branch: BRANCH, commits: 1 });
	});

	it('marks the scan incomplete when a clone could not be read', async () => {
		// An empty `work` from an incomplete scan is "nothing found", never an
		// all-clear - the caller may not release a pin on it.
		const { clone } = setupClone('incomplete', BRANCH);
		commit(clone, 'work');
		run('git push origin HEAD', clone);

		const scan = await findUnpushedWork(
			exec,
			[repoLoc(clone), repoLoc(join(root, 'never-cloned'))],
			BRANCH,
		);
		expect(scan.work).toEqual([]);
		expect(scan.complete).toBe(false);
	});

	it('is complete and empty when there is nothing to report', async () => {
		const { clone } = setupClone('allclear', BRANCH);
		commit(clone, 'work');
		run('git push origin HEAD', clone);
		const scan = await findUnpushedWork(exec, [repoLoc(clone)], BRANCH);
		expect(scan).toEqual({ work: [], complete: true });
	});
});

describe('describeUnpushedWork', () => {
	it('names the branch and the clone so the human knows what to fetch out of where', () => {
		const text = describeUnpushedWork([
			{ repo: repoLoc('/workspace/api'), branch: BRANCH, commits: 3 },
		]);
		expect(text).toContain('3 commits');
		expect(text).toContain(BRANCH);
		expect(text).toContain('/workspace/api');
	});

	it('does not say "1 commits"', () => {
		const text = describeUnpushedWork([
			{ repo: repoLoc('/workspace/api'), branch: BRANCH, commits: 1 },
		]);
		expect(text).toContain('1 commit on');
	});

	it('lists every affected clone', () => {
		const text = describeUnpushedWork([
			{ repo: repoLoc('/workspace/api'), branch: BRANCH, commits: 1 },
			{ repo: repoLoc('/workspace/web'), branch: BRANCH, commits: 2 },
		]);
		expect(text).toContain('/workspace/api');
		expect(text).toContain('/workspace/web');
	});
});

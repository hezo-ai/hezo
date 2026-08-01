import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createWorktree,
	localGitLoc,
	type RepoLoc,
	removeWorktree,
	removeWorktreesWhere,
	type WorktreeLoc,
} from '../src/services/git';
import { HostGitExecutor } from '../src/services/git-executor';

// Exercises the worktree-pruning helpers against real git via HostGitExecutor
// (host path == container path), mirroring git-worktree-state.test.ts. These back
// the admin "Prune worktrees" action that sweeps closed/orphaned tasks' worktrees.

// realpath so prefix comparisons against git-reported worktree paths hold on
// macOS, where the tmpdir sits behind a symlink git resolves.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-wt-prune-')));
const exec = new HostGitExecutor();
const repoLoc = (p: string): RepoLoc => localGitLoc(p);
const wtLoc = (p: string): WorktreeLoc => localGitLoc(p);

function run(cmd: string, cwd?: string): string {
	return execSync(cmd, { cwd, stdio: 'pipe' }).toString();
}

function hasBranch(branch: string): boolean {
	try {
		execSync(`git show-ref --verify --quiet refs/heads/${branch}`, {
			cwd: cloneDir,
			stdio: 'pipe',
		});
		return true;
	} catch {
		return false;
	}
}

let cloneDir: string;
let worktreesRoot: string;

const wtPath = (id: string): string => join(worktreesRoot, id, 'repo');

async function addWt(id: string): Promise<string> {
	const p = wtPath(id);
	const res = await createWorktree(exec, repoLoc(cloneDir), wtLoc(p), `hezo/${id}`);
	expect(res.success).toBe(true);
	return p;
}

beforeAll(() => {
	const bare = join(root, 'bare.git');
	cloneDir = join(root, 'clone');
	worktreesRoot = join(root, 'worktrees');
	mkdirSync(worktreesRoot, { recursive: true });
	run(`git init --bare ${bare}`);
	run(`git clone ${bare} ${cloneDir}`);
	run('git config user.name Test', cloneDir);
	run('git config user.email test@test.com', cloneDir);
	run('git config commit.gpgsign false', cloneDir);
	writeFileSync(join(cloneDir, 'README.md'), '# hi');
	run('git add .', cloneDir);
	run('git commit -m init', cloneDir);
	run('git push', cloneDir);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('removeWorktree', () => {
	it('force-removes a worktree (tree + admin entry) but keeps its branch ref', async () => {
		const p = await addWt('HM-100');
		expect(existsSync(p)).toBe(true);

		await removeWorktree(exec, repoLoc(cloneDir), p);

		expect(existsSync(p)).toBe(false);
		expect(run('git worktree list --porcelain', cloneDir)).not.toContain(p);
		// Committed work survives: the branch ref is untouched.
		expect(hasBranch('hezo/HM-100')).toBe(true);
	});
});

describe('removeWorktreesWhere', () => {
	it('removes only the worktrees whose identifier matches the predicate', async () => {
		const closed = await addWt('HM-200');
		const open = await addWt('HM-201');

		const removed = await removeWorktreesWhere(
			exec,
			repoLoc(cloneDir),
			worktreesRoot,
			(id) => id === 'HM-200',
		);

		expect(removed).toEqual(['HM-200']);
		expect(existsSync(closed)).toBe(false);
		expect(existsSync(open)).toBe(true);
		// Both branch refs survive regardless of whether the worktree was removed.
		expect(hasBranch('hezo/HM-200')).toBe(true);
		expect(hasBranch('hezo/HM-201')).toBe(true);
	});

	it('never removes the main clone worktree, even when the predicate matches everything', async () => {
		const p = await addWt('HM-300');

		const removed = await removeWorktreesWhere(exec, repoLoc(cloneDir), worktreesRoot, () => true);

		expect(removed).toContain('HM-300');
		expect(existsSync(p)).toBe(false);
		// The clone (main worktree, outside the worktrees root) is untouched.
		expect(existsSync(join(cloneDir, 'README.md'))).toBe(true);
		expect(existsSync(join(cloneDir, '.git'))).toBe(true);
	});
});

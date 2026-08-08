import { execSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createWorktree,
	getCloneState,
	getWorktreeState,
	listWorktrees,
	localGitLoc,
	type RepoLoc,
	resetCloneToOrigin,
	type WorktreeLoc,
} from '../src/services/git';
import { HostGitExecutor } from '../src/services/git-executor';

// Canonicalize the temp root: on macOS tmpdir() is under /var (a symlink to
// /private/var) and git reports worktree paths canonicalized, so raw comparisons
// against the mkdtemp path would mismatch. No-op where tmpdir() has no symlinks.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-clone-state-')));
const exec = new HostGitExecutor();
const repoLoc = (p: string): RepoLoc => localGitLoc(p);
const wtLoc = (p: string): WorktreeLoc => localGitLoc(p);

function run(cmd: string, cwd?: string) {
	execSync(cmd, { cwd, stdio: 'pipe' });
}

function configure(dir: string) {
	run('git config user.name Test', dir);
	run('git config user.email test@test.com', dir);
	run('git config commit.gpgsign false', dir);
}

let bare: string;
let clone: string;

beforeAll(() => {
	bare = join(root, 'bare.git');
	clone = join(root, 'clone');
	run(`git init --bare -b main ${bare}`);
	run(`git clone ${bare} ${clone}`);
	configure(clone);
	writeFileSync(join(clone, 'README.md'), '# hi');
	run('git add .', clone);
	run('git commit -m init', clone);
	run('git push', clone);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('getCloneState', () => {
	it('reports a clean, up-to-date clone', async () => {
		const state = await getCloneState(exec, repoLoc(clone));
		expect(state.cloned).toBe(true);
		expect(state.defaultBranch).toBe('main');
		expect(state.headBranch).toBe('main');
		expect(state.head).toMatch(/^[0-9a-f]{40}$/);
		expect(state.head).toBe(execSync('git rev-parse HEAD', { cwd: clone }).toString().trim());
		expect(state.dirty).toBe(false);
		expect(state.ahead).toBe(0);
		expect(state.behind).toBe(0);
	});

	it('reports cloned:false when the directory has no .git', async () => {
		const state = await getCloneState(exec, repoLoc(join(root, 'does-not-exist')));
		expect(state).toEqual({
			cloned: false,
			defaultBranch: null,
			headBranch: null,
			head: null,
			dirty: false,
			ahead: null,
			behind: null,
		});
	});

	it('detects an untracked change as dirty', async () => {
		const dir = join(root, 'dirty');
		run(`git clone ${bare} ${dir}`);
		writeFileSync(join(dir, 'scratch.txt'), 'wip');
		const state = await getCloneState(exec, repoLoc(dir));
		expect(state.dirty).toBe(true);
	});

	it('counts a local unpushed commit as ahead', async () => {
		const dir = join(root, 'ahead');
		run(`git clone ${bare} ${dir}`);
		configure(dir);
		writeFileSync(join(dir, 'a.txt'), 'a');
		run('git add .', dir);
		run('git commit -m local', dir);
		const state = await getCloneState(exec, repoLoc(dir));
		expect(state.ahead).toBe(1);
		expect(state.behind).toBe(0);
	});

	it('counts fetched-but-unmerged origin commits as behind', async () => {
		// Clone the "behind" repo at the current tip FIRST, then advance the remote
		// from a second clone, then fetch (no merge) so local main lags origin/main.
		const dir = join(root, 'behind');
		run(`git clone ${bare} ${dir}`);

		const pusher = join(root, 'pusher');
		run(`git clone ${bare} ${pusher}`);
		configure(pusher);
		writeFileSync(join(pusher, 'b.txt'), 'b');
		run('git add .', pusher);
		run('git commit -m remote-advance', pusher);
		run('git push', pusher);

		run('git fetch origin', dir);
		const state = await getCloneState(exec, repoLoc(dir));
		expect(state.behind).toBe(1);
		expect(state.ahead).toBe(0);
	});

	it('handles a repository with no commits (unborn HEAD, empty remote)', async () => {
		const emptyBare = join(root, 'empty.git');
		const emptyClone = join(root, 'empty-clone');
		run(`git init --bare ${emptyBare}`);
		run(`git clone ${emptyBare} ${emptyClone}`);
		const state = await getCloneState(exec, repoLoc(emptyClone));
		expect(state.cloned).toBe(true);
		expect(state.head).toBeNull();
		expect(state.defaultBranch).toBeNull();
		expect(state.ahead).toBeNull();
		expect(state.behind).toBeNull();
	});
});

describe('resetCloneToOrigin', () => {
	it('discards tracked edits and untracked files, realigning to origin', async () => {
		const dir = join(root, 'reset');
		run(`git clone ${bare} ${dir}`);
		configure(dir);
		writeFileSync(join(dir, 'README.md'), '# tampered'); // tracked edit
		writeFileSync(join(dir, 'junk.txt'), 'junk'); // untracked file
		const before = await getCloneState(exec, repoLoc(dir));
		expect(before.dirty).toBe(true);

		const result = await resetCloneToOrigin(exec, repoLoc(dir));
		expect(result.success).toBe(true);

		const status = execSync('git status --porcelain', { cwd: dir }).toString().trim();
		expect(status).toBe('');
		expect(execSync('cat README.md', { cwd: dir }).toString()).toBe('# hi');
		const head = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
		const originMain = execSync('git rev-parse origin/main', { cwd: dir }).toString().trim();
		expect(head).toBe(originMain);
	});

	it('resets a local divergent commit back to the origin tip', async () => {
		const dir = join(root, 'reset-diverged');
		run(`git clone ${bare} ${dir}`);
		configure(dir);
		writeFileSync(join(dir, 'c.txt'), 'c');
		run('git add .', dir);
		run('git commit -m diverge', dir);
		const originMain = execSync('git rev-parse origin/main', { cwd: dir }).toString().trim();

		const result = await resetCloneToOrigin(exec, repoLoc(dir));
		expect(result.success).toBe(true);
		expect(execSync('git rev-parse HEAD', { cwd: dir }).toString().trim()).toBe(originMain);
	});

	it('fails gracefully on a repository with no commits', async () => {
		const emptyBare = join(root, 'empty-reset.git');
		const emptyClone = join(root, 'empty-reset-clone');
		run(`git init --bare ${emptyBare}`);
		run(`git clone ${emptyBare} ${emptyClone}`);
		const result = await resetCloneToOrigin(exec, repoLoc(emptyClone));
		expect(result.success).toBe(false);
		expect(result.error).toBeTruthy();
	});
});

describe('listWorktrees (exported)', () => {
	it('lists the main worktree plus a linked task worktree', async () => {
		const dir = join(root, 'wt-clone');
		const worktree = join(root, 'wt-linked');
		run(`git clone ${bare} ${dir}`);
		configure(dir);
		const created = await createWorktree(exec, repoLoc(dir), wtLoc(worktree), 'hezo/HM-1');
		expect(created.success).toBe(true);

		const entries = await listWorktrees(exec, repoLoc(dir));
		expect(entries.length).toBe(2);
		expect(entries[0].path).toBe(dir); // main worktree first
		const linked = entries.find((e) => e.path === worktree);
		expect(linked?.branch).toBe('refs/heads/hezo/HM-1');
	});
});

describe('getWorktreeState', () => {
	it('reports clean then dirty for a worktree', async () => {
		const dir = join(root, 'wt-state-clone');
		const worktree = join(root, 'wt-state-linked');
		run(`git clone ${bare} ${dir}`);
		configure(dir);
		await createWorktree(exec, repoLoc(dir), wtLoc(worktree), 'hezo/HM-2');

		const clean = await getWorktreeState(exec, wtLoc(worktree));
		expect(clean.dirty).toBe(false);
		expect(clean.head).toMatch(/^[0-9a-f]{40}$/);

		writeFileSync(join(worktree, 'wip.txt'), 'wip');
		const dirty = await getWorktreeState(exec, wtLoc(worktree));
		expect(dirty.dirty).toBe(true);
	});
});

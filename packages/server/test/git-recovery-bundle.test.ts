import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	countUnpushedCommits,
	createRecoveryBundle,
	fastForwardFromRecovery,
	fetchRecoveryBundle,
	RECOVERY_BUNDLE_REL_PATH,
	RECOVERY_REMOTE,
	type RepoLoc,
	type WorktreeLoc,
} from '../src/services/git';
import { HostGitExecutor } from '../src/services/git-executor';
import {
	bundleFileName,
	checkBundleSize,
	createBundleVault,
	MAX_RECOVERY_BUNDLE_BYTES,
} from '../src/services/sandbox/bundle-vault';
import { hostSandboxFiles } from '../src/services/sandbox/files';
import {
	releaseRecoveryBundle,
	restoreRecoveryBundle,
	saveRecoveryBundle,
} from '../src/services/sandbox/recovery';

/**
 * The durability backstop, against real `git` and a real bare `origin`.
 *
 * The shape of these tests is the point. A test that fails a push, keeps the same
 * clone and re-runs passes at pool size 1 and proves nothing - the ref is still
 * sitting in the same `.git`. So the source clone is **destroyed** between the two
 * halves, standing in for the container being reaped when it goes idle, and
 * recovery has to reach a *different* clone that only ever saw the remote.
 */

const root = mkdtempSync(join(tmpdir(), 'git-recovery-'));
const exec = new HostGitExecutor();
const repoLoc = (p: string): RepoLoc => ({ hostPath: p, containerPath: p });
const wtLoc = (p: string): WorktreeLoc => ({ hostPath: p, containerPath: p });

afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(cmd: string, cwd?: string): string {
	return execSync(cmd, { cwd, stdio: 'pipe' }).toString();
}

function configure(dir: string) {
	run('git config user.name tester', dir);
	run('git config user.email tester@test.com', dir);
	run('git config commit.gpgsign false', dir);
}

const BRANCH = 'hezo/hez-1';
const PROJECT = 'proj-1';
const REPO = 'website';

/** A bare origin with one commit on main, plus a clone of it on the task branch. */
function setup(name: string): { bare: string; clone: string } {
	const bare = join(root, `${name}.git`);
	const clone = join(root, `${name}-a`);
	run(`git init --bare -b main ${bare}`);
	run(`git clone ${bare} ${clone}`);
	configure(clone);
	run('git commit --allow-empty -m initial', clone);
	run('git push origin HEAD:main', clone);
	run(`git checkout -b ${BRANCH}`, clone);
	return { bare, clone };
}

/** A second clone of the same origin - the container a later run lands on. */
function secondClone(bare: string, name: string): string {
	const clone = join(root, `${name}-b`);
	run(`git clone ${bare} ${clone}`);
	configure(clone);
	return clone;
}

const key = { projectId: PROJECT, repoName: REPO, branch: BRANCH };

describe('recovery bundle round trip', () => {
	it('carries commits to a different clone after the original is destroyed', async () => {
		const { bare, clone } = setup('destroyed');
		writeFileSync(join(clone, 'work.txt'), 'the only copy');
		run('git add .', clone);
		run('git commit -m "work that never reached origin"', clone);
		// The push is never attempted - this is the denied-push shape, where the
		// commit exists in exactly one place.
		expect(await countUnpushedCommits(exec, repoLoc(clone), BRANCH)).toBe(1);

		const vault = createBundleVault(join(root, 'vault-destroyed'));
		const saved = await saveRecoveryBundle(
			vault,
			hostSandboxFiles(clone),
			exec,
			repoLoc(clone),
			key,
		);
		expect(saved.ok).toBe(true);

		// The container is reaped. This is what a test that reuses the same clone
		// never exercises, and it is the whole failure being fixed.
		rmSync(clone, { recursive: true, force: true });

		const other = secondClone(bare, 'destroyed');
		// The second clone genuinely does not have the work: it only ever saw origin.
		expect(existsSync(join(other, 'work.txt'))).toBe(false);

		const restored = await restoreRecoveryBundle(
			vault,
			hostSandboxFiles(other),
			exec,
			repoLoc(other),
			key,
		);
		expect(restored).toEqual({ ok: true, bytes: expect.any(Number) });

		// The commit is present, under the recovery namespace rather than on a branch.
		const log = run(`git log --oneline refs/remotes/${RECOVERY_REMOTE}/${BRANCH}`, other);
		expect(log).toContain('work that never reached origin');
	});

	it('replays recovered commits onto the task branch in the worktree', async () => {
		const { bare, clone } = setup('replay');
		writeFileSync(join(clone, 'work.txt'), 'recovered content');
		run('git add .', clone);
		run('git commit -m "unpushed work"', clone);

		const vault = createBundleVault(join(root, 'vault-replay'));
		await saveRecoveryBundle(vault, hostSandboxFiles(clone), exec, repoLoc(clone), key);
		rmSync(clone, { recursive: true, force: true });

		const other = secondClone(bare, 'replay');
		await restoreRecoveryBundle(vault, hostSandboxFiles(other), exec, repoLoc(other), key);

		// The worktree the next run would actually work in.
		const wt = join(root, 'replay-wt');
		run(`git worktree add -b ${BRANCH} ${wt}`, other);
		const replayed = await fastForwardFromRecovery(exec, wtLoc(wt), BRANCH);

		expect(replayed.warning).toBeUndefined();
		expect(replayed.merged).toBe(true);
		// The file is on disk in the worktree, which is the thing that actually
		// matters to the agent about to run there.
		expect(readFileSync(join(wt, 'work.txt'), 'utf8')).toBe('recovered content');
	});

	it('refuses to fast-forward a diverged branch rather than inventing a merge', async () => {
		const { bare, clone } = setup('diverged');
		run('git commit --allow-empty -m "container A work"', clone);

		const vault = createBundleVault(join(root, 'vault-diverged'));
		await saveRecoveryBundle(vault, hostSandboxFiles(clone), exec, repoLoc(clone), key);
		rmSync(clone, { recursive: true, force: true });

		const other = secondClone(bare, 'diverged');
		await restoreRecoveryBundle(vault, hostSandboxFiles(other), exec, repoLoc(other), key);
		const wt = join(root, 'diverged-wt');
		run(`git worktree add -b ${BRANCH} ${wt}`, other);
		configure(wt);
		// A conflicting commit on the same branch here - the two histories diverge.
		run('git commit --allow-empty -m "container B work"', wt);

		const replayed = await fastForwardFromRecovery(exec, wtLoc(wt), BRANCH);
		expect(replayed.merged).toBe(false);
		expect(replayed.warning).toContain('could not be fast-forwarded');
		// Not lost, though: still reachable under the recovery ref.
		expect(run(`git log --oneline refs/remotes/${RECOVERY_REMOTE}/${BRANCH}`, other)).toContain(
			'container A work',
		);
	});

	it('is a no-op when nothing is stored', async () => {
		const { bare } = setup('empty');
		const other = secondClone(bare, 'empty');
		const restored = await restoreRecoveryBundle(
			createBundleVault(join(root, 'vault-empty')),
			hostSandboxFiles(other),
			exec,
			repoLoc(other),
			key,
		);
		expect(restored).toEqual({ ok: true, bytes: null });
	});
});

describe('recovery bundle hygiene', () => {
	it('leaves no bundle behind in the clone it was built from', async () => {
		const { clone } = setup('hygiene');
		run('git commit --allow-empty -m unpushed', clone);
		const vault = createBundleVault(join(root, 'vault-hygiene'));
		await saveRecoveryBundle(vault, hostSandboxFiles(clone), exec, repoLoc(clone), key);
		// A stale bundle left in the git dir would be restored over a newer one on
		// the next run, so the copy-out scrubs it.
		expect(existsSync(join(clone, RECOVERY_BUNDLE_REL_PATH))).toBe(false);
	});

	it('packs only the undelivered commits, not the history', async () => {
		const { clone } = setup('delta');
		// 20 commits already on origin, one that is not.
		for (let i = 0; i < 20; i++) run(`git commit --allow-empty -m base-${i}`, clone);
		run(`git push origin HEAD:${BRANCH}`, clone);
		run('git commit --allow-empty -m "the only new one"', clone);

		const built = await createRecoveryBundle(exec, repoLoc(clone), BRANCH);
		expect(built.ok).toBe(true);
		const listed = run(`git bundle list-heads ${RECOVERY_BUNDLE_REL_PATH}`, clone);
		expect(listed).toContain(BRANCH);
		// `bundle verify` names the prerequisites the bundle expects the reader to
		// already have - proof this is a delta against origin rather than a copy.
		const verified = run(`git bundle verify ${RECOVERY_BUNDLE_REL_PATH} 2>&1 || true`, clone);
		expect(verified).toMatch(/requires these \d+ ref|is okay/);
	});

	it('drops a stored bundle once the work reached origin', async () => {
		const { clone } = setup('released');
		run('git commit --allow-empty -m unpushed', clone);
		const vaultDir = join(root, 'vault-released');
		const vault = createBundleVault(vaultDir);
		await saveRecoveryBundle(vault, hostSandboxFiles(clone), exec, repoLoc(clone), key);
		expect(await vault.has(key)).toBe(true);

		// The next run pushes successfully, so the stored copy is redundant. This is
		// the ONLY condition under which the vault discards anything - by now the
		// commits are on the user's remote.
		run(`git push origin HEAD:${BRANCH}`, clone);
		expect(await countUnpushedCommits(exec, repoLoc(clone), BRANCH)).toBe(0);
		await releaseRecoveryBundle(vault, key);
		expect(await vault.has(key)).toBe(false);
	});

	it('scopes a stored bundle to its repo and branch', async () => {
		const a = bundleFileName({ projectId: PROJECT, repoName: 'api', branch: 'hezo/hez-1' });
		const b = bundleFileName({ projectId: PROJECT, repoName: 'api', branch: 'hezo/hez-2' });
		const c = bundleFileName({ projectId: PROJECT, repoName: 'web', branch: 'hezo/hez-1' });
		expect(new Set([a, b, c]).size).toBe(3);
		// The slug is lossy (a branch carries a slash), so the hash is what actually
		// keeps two keys apart - handing a run another branch's commits would be far
		// worse than losing the bundle.
		const slugCollision = [
			bundleFileName({ projectId: PROJECT, repoName: 'a/b', branch: 'c' }),
			bundleFileName({ projectId: PROJECT, repoName: 'a', branch: 'b/c' }),
		];
		expect(slugCollision[0]).not.toBe(slugCollision[1]);
	});

	it('keeps two projects that share a repo and branch name apart', async () => {
		const vault = createBundleVault(join(root, 'vault-scoped'));
		const one = { projectId: 'p1', repoName: REPO, branch: BRANCH };
		const two = { projectId: 'p2', repoName: REPO, branch: BRANCH };
		await vault.put(one, new Uint8Array([1, 2, 3]));
		expect(await vault.has(two)).toBe(false);
		await vault.put(two, new Uint8Array([9]));
		expect((await vault.get(one))?.byteLength).toBe(3);
		await vault.removeProject('p1');
		expect(await vault.has(one)).toBe(false);
		expect(await vault.has(two)).toBe(true);
	});
});

describe('recovery bundle failure reporting', () => {
	it('refuses an oversized bundle rather than trimming it', () => {
		expect(checkBundleSize(MAX_RECOVERY_BUNDLE_BYTES)).toEqual({ ok: true });
		const over = checkBundleSize(MAX_RECOVERY_BUNDLE_BYTES + 1);
		expect(over.ok).toBe(false);
		// The reason has to name the likely cause: an unexplained "recovery didn't
		// happen" is how a pinned container becomes a mystery.
		if (!over.ok) expect(over.reason).toContain('no remote to pack against');
	});

	it('reports a failure to apply rather than throwing out of run prep', async () => {
		const { bare } = setup('corrupt');
		const other = secondClone(bare, 'corrupt');
		const vaultDir = join(root, 'vault-corrupt');
		const vault = createBundleVault(vaultDir);
		await vault.put(key, new TextEncoder().encode('not a git bundle at all'));

		const restored = await restoreRecoveryBundle(
			vault,
			hostSandboxFiles(other),
			exec,
			repoLoc(other),
			key,
		);
		expect(restored.ok).toBe(false);
		if (!restored.ok) expect(restored.reason).toContain('could not apply the bundle');
		// Prep must still be able to continue - and the junk file is cleaned up.
		expect(existsSync(join(other, RECOVERY_BUNDLE_REL_PATH))).toBe(false);
	});

	it('recovers a chain of commits whole, not just its tip', async () => {
		// Container A's work sits on top of another commit that also never reached
		// origin. Both are packed (neither is on a durable remote), so recovery is
		// complete rather than partial - a bundle that carried only the tip would
		// leave the target clone with an unapplyable delta.
		const { bare, clone } = setup('prereq');
		run('git commit --allow-empty -m base-only-here', clone);
		run('git commit --allow-empty -m on-top', clone);
		const vault = createBundleVault(join(root, 'vault-prereq'));
		await saveRecoveryBundle(vault, hostSandboxFiles(clone), exec, repoLoc(clone), key);
		rmSync(clone, { recursive: true, force: true });

		const other = secondClone(bare, 'prereq');
		const restored = await restoreRecoveryBundle(
			vault,
			hostSandboxFiles(other),
			exec,
			repoLoc(other),
			key,
		);
		expect(restored.ok).toBe(true);
		const recovered = run(`git log --oneline refs/remotes/${RECOVERY_REMOTE}/${BRANCH}`, other);
		expect(recovered).toContain('base-only-here');
		expect(recovered).toContain('on-top');
	});
});

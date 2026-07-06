import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialReadmeContent, seedInitialCommitIfEmpty } from '../src/services/git';
import { HostGitExecutor } from '../src/services/git-executor';

let root: string;

// Git runs against host temp dirs here, so host and container paths coincide.
// The executor carries a git identity so the seed's `git commit` has an author
// (the prep executor supplies this in production via buildGitIdentityEnv).
const exec = new HostGitExecutor({
	GIT_AUTHOR_NAME: 'Hezo',
	GIT_AUTHOR_EMAIL: 'agent@hezo.local',
	GIT_COMMITTER_NAME: 'Hezo',
	GIT_COMMITTER_EMAIL: 'agent@hezo.local',
});
const loc = (p: string) => ({ hostPath: p, containerPath: p });

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Test',
			GIT_AUTHOR_EMAIL: 'test@example.com',
			GIT_COMMITTER_NAME: 'Test',
			GIT_COMMITTER_EMAIL: 'test@example.com',
		},
	})
		.toString()
		.trim();
}

/** A bare repo with no commits, default branch `main`. */
function makeEmptyRemote(): string {
	const bare = join(root, 'empty.git');
	git(root, 'init', '--bare', '-b', 'main', bare);
	return bare;
}

/** A bare repo carrying one commit with the given files, default branch `main`. */
function makeRemoteWithCommit(files: Record<string, string>): string {
	const seed = join(root, 'seed');
	mkdirSync(seed, { recursive: true });
	git(seed, 'init', '-b', 'main');
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(seed, name), content);
	}
	git(seed, 'add', '-A');
	git(seed, 'commit', '-m', 'initial');
	const bare = join(root, 'remote.git');
	git(root, 'clone', '--bare', seed, bare);
	return bare;
}

/** Clone `remote` into a fresh work dir and return its path. */
function cloneInto(remote: string, name = 'work'): string {
	const target = join(root, name);
	git(root, 'clone', `file://${remote}`, target);
	return target;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'seed-initial-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('initialReadmeContent', () => {
	it('is the repo name as a markdown heading', () => {
		expect(initialReadmeContent('acme/widgets')).toBe('# widgets\n');
		// A bare name (no owner) is used as-is.
		expect(initialReadmeContent('widgets')).toBe('# widgets\n');
	});
});

describe('seedInitialCommitIfEmpty', () => {
	it('seeds a minimal README initial commit and pushes it to main when the remote is empty', async () => {
		const remote = makeEmptyRemote();
		const work = cloneInto(remote);

		const res = await seedInitialCommitIfEmpty(exec, 'acme/widgets', loc(work), false);

		expect(res.seeded).toBe(true);
		expect(res.error).toBeUndefined();

		// The local working tree gained the minimal README...
		expect(existsSync(join(work, 'README.md'))).toBe(true);
		// ...and it was pushed to the remote's `main` as an "Initial commit".
		expect(git(remote, 'rev-parse', '--verify', 'main')).toMatch(/^[0-9a-f]{40}$/);
		expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('Initial commit');
		expect(git(remote, 'show', 'main:README.md')).toBe('# widgets');
	});

	it('is an idempotent no-op when the remote already has commits', async () => {
		const remote = makeRemoteWithCommit({ 'app.js': 'console.log(1)\n' });
		const work = cloneInto(remote);
		const tipBefore = git(remote, 'rev-parse', 'main');

		const res = await seedInitialCommitIfEmpty(exec, 'acme/widgets', loc(work), false);

		expect(res.seeded).toBe(false);
		expect(res.error).toBeUndefined();
		// No README was written and the remote tip is untouched (no extra commit).
		expect(existsSync(join(work, 'README.md'))).toBe(false);
		expect(git(remote, 'rev-parse', 'main')).toBe(tipBefore);
	});

	it('folds a pre-populated working tree into the same initial commit, keeping its files', async () => {
		// The adopt-in-place case: an agent populated the directory (connected to an
		// empty remote) before the first commit exists. Its files must survive.
		const remote = makeEmptyRemote();
		const work = join(root, 'work');
		git(root, 'clone', `file://${remote}`, work);
		writeFileSync(join(work, 'index.html'), '<html></html>');

		const res = await seedInitialCommitIfEmpty(exec, 'acme/site', loc(work), false);

		expect(res.seeded).toBe(true);
		// Both the agent's file and the seeded README are in the pushed initial commit.
		expect(git(remote, 'show', 'main:index.html')).toBe('<html></html>');
		expect(git(remote, 'show', 'main:README.md')).toBe('# site');
	});

	it('does not overwrite an existing README when folding the working tree', async () => {
		const remote = makeEmptyRemote();
		const work = join(root, 'work');
		git(root, 'clone', `file://${remote}`, work);
		writeFileSync(join(work, 'README.md'), 'hand-written\n');

		const res = await seedInitialCommitIfEmpty(exec, 'acme/site', loc(work), false);

		expect(res.seeded).toBe(true);
		// The pre-existing README is preserved verbatim, not clobbered by the default.
		expect(git(remote, 'show', 'main:README.md')).toBe('hand-written');
	});

	it('re-pushes a stranded local commit when a prior push failed, without re-committing', async () => {
		// A prior attempt committed locally but its push failed (transient network),
		// leaving the remote empty and HEAD born. The retry must push that same commit,
		// not re-run `git commit` (which would die with "nothing to commit").
		const remote = makeEmptyRemote();
		const work = cloneInto(remote);
		writeFileSync(join(work, 'README.md'), '# widgets\n');
		git(work, 'add', '-A');
		git(work, 'commit', '-m', 'Initial commit');
		const strandedSha = git(work, 'rev-parse', 'HEAD');
		// Remote is still empty — nothing has been pushed yet (no `main` branch).
		expect(git(remote, 'branch', '--list', 'main')).toBe('');

		const res = await seedInitialCommitIfEmpty(exec, 'acme/widgets', loc(work), false);

		expect(res.seeded).toBe(true);
		expect(res.error).toBeUndefined();
		// The *existing* local commit reached the remote (same SHA — no new commit).
		expect(git(remote, 'rev-parse', 'main')).toBe(strandedSha);
	});
});

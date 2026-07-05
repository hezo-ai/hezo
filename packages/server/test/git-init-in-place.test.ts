import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectExistingRepo } from '../src/services/git';
import { HostGitExecutor } from '../src/services/git-executor';

let root: string;

// Git runs against host temp dirs here, so host and container paths coincide.
const exec = new HostGitExecutor();
const loc = (p: string) => ({ hostPath: p, containerPath: p });

function git(cwd: string, ...args: string[]): void {
	execFileSync('git', args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Test',
			GIT_AUTHOR_EMAIL: 'test@example.com',
			GIT_COMMITTER_NAME: 'Test',
			GIT_COMMITTER_EMAIL: 'test@example.com',
		},
	});
}

/** A bare repo with one commit containing the given files, default branch `main`. */
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

function makeEmptyRemote(): string {
	const bare = join(root, 'empty.git');
	git(root, 'init', '--bare', '-b', 'main', bare);
	return bare;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'init-in-place-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('connectExistingRepo', () => {
	it('keeps existing files as the initial tree when the remote is empty', async () => {
		const remote = makeEmptyRemote();
		const target = join(root, 'work');
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, 'index.html'), '<html></html>');

		const res = await connectExistingRepo(exec, `file://${remote}`, loc(target), false);

		expect(res.success).toBe(true);
		expect(existsSync(join(target, '.git'))).toBe(true);
		expect(readFileSync(join(target, 'index.html'), 'utf8')).toBe('<html></html>');
	});

	it('checks out remote content while preserving non-conflicting local files', async () => {
		const remote = makeRemoteWithCommit({ 'README.md': 'from remote\n' });
		const target = join(root, 'work');
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, 'local-only.txt'), 'scaffold\n');

		const res = await connectExistingRepo(exec, `file://${remote}`, loc(target), false);

		expect(res.success).toBe(true);
		expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('from remote\n');
		expect(readFileSync(join(target, 'local-only.txt'), 'utf8')).toBe('scaffold\n');
	});

	it('repoints an already-configured origin instead of failing on remote add', async () => {
		// A directory healed after a previous partial failure (or a stray agent
		// setup) can already carry an origin; connect must be idempotent.
		const remote = makeEmptyRemote();
		const target = join(root, 'work');
		mkdirSync(target, { recursive: true });
		git(target, 'init', '-b', 'main');
		git(target, 'remote', 'add', 'origin', 'git@github.com:someone/else.git');
		writeFileSync(join(target, 'index.html'), '<html></html>');

		const res = await connectExistingRepo(exec, `file://${remote}`, loc(target), false);

		expect(res.success).toBe(true);
		expect(
			execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: target }).toString().trim(),
		).toBe(`file://${remote}`);
		expect(readFileSync(join(target, 'index.html'), 'utf8')).toBe('<html></html>');
	});

	it('fails and rolls back its .git when a local file conflicts with the remote', async () => {
		const remote = makeRemoteWithCommit({ 'README.md': 'from remote\n' });
		const target = join(root, 'work');
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, 'README.md'), 'local version\n');

		const res = await connectExistingRepo(exec, `file://${remote}`, loc(target), false);

		expect(res.success).toBe(false);
		expect(res.error).toBeTruthy();
		// Rolled back so the directory stays clone-eligible on retry, and the
		// agent's file is untouched.
		expect(existsSync(join(target, '.git'))).toBe(false);
		expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('local version\n');
	});
});

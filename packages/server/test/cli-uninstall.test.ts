import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUninstall } from '../src/cli';
import type { DockerClient } from '../src/services/docker';
import { removeProvisionedContainers } from '../src/services/uninstall';
import { getRunSocketDir } from '../src/services/workspace';

// Exercises the `hezo uninstall` subcommand end-to-end against real directories
// on disk. Docker cleanup is always injected so no test touches a live daemon.

const argv = (...tokens: string[]) => ['bun', 'src/index.ts', ...tokens];

const tempDirs: string[] = [];
function makeDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'hezo-cli-uninstall-'));
	tempDirs.push(dir);
	return dir;
}

/** Recreate the on-disk shape the phantom-mount bug leaves behind. */
function seedProjectTree(dataDir: string): string {
	const projectDir = join(
		dataDir,
		'teams',
		'00000000-0000-0000-0000-000000000001',
		'projects',
		'a6630b1a-b1d0-4a8e-a2fe-012b3c69dd9d',
	);
	// The nested `workspace/.previews` mountpoint is exactly what a plain rm -rf
	// trips over on macOS; recreate the layout (sans the ACL, which is darwin-only).
	mkdirSync(join(projectDir, 'workspace', '.previews'), { recursive: true });
	mkdirSync(join(projectDir, '.previews', 'agent-1'), { recursive: true });
	mkdirSync(join(projectDir, 'worktrees'), { recursive: true });
	writeFileSync(join(projectDir, 'workspace', 'file.md'), 'x');
	writeFileSync(join(dataDir, 'hezo-secret.dat'), 'y');
	return projectDir;
}

let prevDataDir: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	prevDataDir = process.env.HEZO_DATA_DIR;
	delete process.env.HEZO_DATA_DIR;
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	if (prevDataDir === undefined) delete process.env.HEZO_DATA_DIR;
	else process.env.HEZO_DATA_DIR = prevDataDir;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const noContainers = { removeContainers: async () => 0 };

describe('hezo uninstall subcommand', () => {
	it('returns false when another (or no) subcommand is invoked', async () => {
		expect(await runUninstall(argv('--port', '8080'))).toBe(false);
		expect(await runUninstall(argv('backup'))).toBe(false);
		expect(await runUninstall(argv('restore', '/tmp/x'))).toBe(false);
	});

	it('reports nothing to remove when the data dir does not exist', async () => {
		const dir = join(tmpdir(), `hezo-absent-${process.pid}-never`);
		expect(existsSync(dir)).toBe(false);
		expect(await runUninstall(argv('uninstall', '--data-dir', dir, '--yes'), noContainers)).toBe(
			true,
		);
		expect(logSpy.mock.calls.flat().join('\n')).toContain('Nothing to remove');
	});

	it('without --yes prints what would be removed and deletes nothing', async () => {
		const dataDir = makeDataDir();
		seedProjectTree(dataDir);

		expect(await runUninstall(argv('uninstall', '--data-dir', dataDir), noContainers)).toBe(true);

		expect(existsSync(dataDir)).toBe(true); // untouched
		const out = logSpy.mock.calls.flat().join('\n');
		expect(out).toContain(dataDir);
		expect(out).toContain('--yes');
	});

	it('with --yes removes the whole data directory, including the nested previews tree', async () => {
		const dataDir = makeDataDir();
		const projectDir = seedProjectTree(dataDir);
		expect(existsSync(join(projectDir, 'workspace', '.previews'))).toBe(true);

		expect(
			await runUninstall(argv('uninstall', '--data-dir', dataDir, '--yes'), noContainers),
		).toBe(true);

		expect(existsSync(dataDir)).toBe(false);
		expect(logSpy.mock.calls.flat().join('\n')).toContain(
			`Removed Hezo data directory: ${dataDir}`,
		);
	});

	it('refuses while a live instance lock is present, leaving the dir intact', async () => {
		const dataDir = makeDataDir();
		seedProjectTree(dataDir);
		// A live lock is this test process's own (alive) PID.
		writeFileSync(join(dataDir, 'hezo.lock'), `${process.pid}\n`, 'utf8');

		await expect(
			runUninstall(argv('uninstall', '--data-dir', dataDir, '--yes'), noContainers),
		).rejects.toThrow(/server appears to be running/i);
		expect(existsSync(dataDir)).toBe(true);
	});

	it('ignores a stale lock (dead PID) and still removes the dir', async () => {
		const dataDir = makeDataDir();
		seedProjectTree(dataDir);
		// PID 2^31-1 is effectively never a live process.
		writeFileSync(join(dataDir, 'hezo.lock'), `${2147483647}\n`, 'utf8');

		expect(
			await runUninstall(argv('uninstall', '--data-dir', dataDir, '--yes'), noContainers),
		).toBe(true);
		expect(existsSync(dataDir)).toBe(false);
	});

	it('reads HEZO_DATA_DIR when --data-dir is omitted', async () => {
		const dataDir = makeDataDir();
		seedProjectTree(dataDir);
		process.env.HEZO_DATA_DIR = dataDir;

		expect(await runUninstall(argv('uninstall', '--yes'), noContainers)).toBe(true);
		expect(existsSync(dataDir)).toBe(false);
	});

	it('surfaces the container-cleanup count and continues when cleanup throws', async () => {
		const dataDir = makeDataDir();
		seedProjectTree(dataDir);

		expect(
			await runUninstall(argv('uninstall', '--data-dir', dataDir, '--yes'), {
				removeContainers: async () => 3,
			}),
		).toBe(true);
		expect(logSpy.mock.calls.flat().join('\n')).toContain('Removed 3 Hezo container(s)');
		expect(existsSync(dataDir)).toBe(false);
	});

	it('notes when Docker is unreachable but still removes the dir', async () => {
		const dataDir = makeDataDir();
		seedProjectTree(dataDir);

		expect(
			await runUninstall(argv('uninstall', '--data-dir', dataDir, '--yes'), {
				removeContainers: async () => null,
			}),
		).toBe(true);
		expect(logSpy.mock.calls.flat().join('\n')).toContain('Docker not reachable');
		expect(existsSync(dataDir)).toBe(false);
	});

	it('a container-cleanup failure never aborts the uninstall', async () => {
		const dataDir = makeDataDir();
		seedProjectTree(dataDir);

		expect(
			await runUninstall(argv('uninstall', '--data-dir', dataDir, '--yes'), {
				removeContainers: async () => {
					throw new Error('daemon exploded');
				},
			}),
		).toBe(true);
		expect(logSpy.mock.calls.flat().join('\n')).toContain('Could not clean up Hezo containers');
		expect(existsSync(dataDir)).toBe(false);
	});

	it('also removes the per-run socket directory keyed off the data dir', async () => {
		const dataDir = makeDataDir();
		seedProjectTree(dataDir);
		const sockDir = getRunSocketDir(dataDir);
		mkdirSync(sockDir, { recursive: true });
		writeFileSync(join(sockDir, 'run.sock'), '');
		expect(existsSync(sockDir)).toBe(true);

		expect(
			await runUninstall(argv('uninstall', '--data-dir', dataDir, '--yes'), noContainers),
		).toBe(true);
		expect(existsSync(sockDir)).toBe(false);
	});
});

describe('removeProvisionedContainers', () => {
	function stubDocker(overrides: Partial<DockerClient>): DockerClient {
		return {
			ping: async () => true,
			listContainersByLabel: async () => [],
			stopContainer: async () => {},
			removeContainer: async () => {},
			...overrides,
		} as unknown as DockerClient;
	}

	it('returns null without listing when the daemon is unreachable', async () => {
		let listed = false;
		const docker = stubDocker({
			ping: async () => false,
			listContainersByLabel: async () => {
				listed = true;
				return [];
			},
		});
		expect(await removeProvisionedContainers(docker)).toBeNull();
		expect(listed).toBe(false);
	});

	it('stops and force-removes every labelled container and counts removals', async () => {
		const stopped: string[] = [];
		const removed: string[] = [];
		const docker = stubDocker({
			listContainersByLabel: async () => [
				{ Id: 'cid-1', Names: ['/hezo-a-1'] },
				{ Id: 'cid-2', Names: ['/hezo-b-2'] },
			],
			stopContainer: async (id: string) => {
				stopped.push(id);
			},
			removeContainer: async (id: string) => {
				removed.push(id);
			},
		});
		expect(await removeProvisionedContainers(docker)).toBe(2);
		expect(stopped).toEqual(['cid-1', 'cid-2']);
		expect(removed).toEqual(['cid-1', 'cid-2']);
	});

	it('keeps going when a stop fails, and does not count a failed remove', async () => {
		const docker = stubDocker({
			listContainersByLabel: async () => [
				{ Id: 'cid-1', Names: ['/hezo-a-1'] },
				{ Id: 'cid-2', Names: ['/hezo-b-2'] },
			],
			stopContainer: async (id: string) => {
				if (id === 'cid-1') throw new Error('already stopped');
			},
			removeContainer: async (id: string) => {
				if (id === 'cid-2') throw new Error('removal in progress');
			},
		});
		// cid-1 removes despite the stop error; cid-2's remove throws → not counted.
		expect(await removeProvisionedContainers(docker)).toBe(1);
	});
});

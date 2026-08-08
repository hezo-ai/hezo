import { afterEach, describe, expect, it } from 'vitest';
import {
	chownToRunUser,
	clearContainerRunUserCache,
	mkdirInContainer,
	resolveContainerRunUser,
} from '../src/services/container-user';
import type { ContainerEngine } from '../src/services/sandbox/types';

interface ExecRec {
	Cmd: string[];
	User?: string;
}

/**
 * A docker mock that answers `id` probes from a small fake passwd and records every
 * exec. `users` maps username → {uid,gid}; a probe for an absent user exits 1.
 * `defaultUser` is what a bare `id -u` (no username) resolves to.
 */
function fakeDocker(opts: {
	users?: Record<string, { uid: number; gid: number }>;
	defaultUser?: string;
	throwOnExec?: boolean;
}) {
	const users = opts.users ?? { node: { uid: 1000, gid: 1000 }, root: { uid: 0, gid: 0 } };
	const defaultUser = opts.defaultUser ?? 'root';
	const calls: ExecRec[] = [];
	const byId = new Map<string, ExecRec>();
	let seq = 0;

	const resolveProbe = (script: string): { code: number; out: string } => {
		// `id -u <name> && …` (named probe) or `id -u && …` (default-user probe).
		const m = script.match(/^id -u (\S+) &&/);
		const name = m ? m[1] : defaultUser;
		const u = users[name];
		if (!u) return { code: 1, out: `id: '${name}': no such user\n` };
		return { code: 0, out: `${u.uid}\n${u.gid}\n${name}\n` };
	};

	const docker = {
		execCreate: async (_id: string, config: ExecRec) => {
			if (opts.throwOnExec) throw new Error('docker unreachable');
			const execId = `exec-${seq++}`;
			calls.push(config);
			byId.set(execId, config);
			return execId;
		},
		execStart: async (execId: string) => {
			const rec = byId.get(execId);
			const script = rec?.Cmd?.[2] ?? '';
			if (script.startsWith('id -u')) return { stdout: resolveProbe(script).out, stderr: '' };
			return { stdout: '', stderr: '' };
		},
		execInspect: async (execId: string) => {
			const rec = byId.get(execId);
			const script = rec?.Cmd?.[2] ?? '';
			const code = script.startsWith('id -u') ? resolveProbe(script).code : 0;
			return { ExitCode: code, Running: false, Pid: 0 };
		},
	} as unknown as ContainerEngine;

	return { docker, calls };
}

describe('resolveContainerRunUser', () => {
	afterEach(() => clearContainerRunUserCache());

	it('detects the `node` user on the stock image', async () => {
		const { docker } = fakeDocker({});
		const runUser = await resolveContainerRunUser(docker, 'c-node');
		expect(runUser).toEqual({ name: 'node', uid: 1000, gid: 1000 });
	});

	it('detects a non-1000 node uid (does not assume 1000)', async () => {
		const { docker } = fakeDocker({ users: { node: { uid: 2002, gid: 2002 } } });
		const runUser = await resolveContainerRunUser(docker, 'c-node-2002');
		expect(runUser).toEqual({ name: 'node', uid: 2002, gid: 2002 });
	});

	it('falls back to the container default user when there is no `node` user', async () => {
		// Custom image: no node user, default user is root.
		const { docker } = fakeDocker({ users: { root: { uid: 0, gid: 0 } }, defaultUser: 'root' });
		const runUser = await resolveContainerRunUser(docker, 'c-custom');
		expect(runUser).toEqual({ name: 'root', uid: 0, gid: 0 });
	});

	it('falls back to a non-root default user (custom image with its own user)', async () => {
		const { docker } = fakeDocker({
			users: { appuser: { uid: 1500, gid: 1500 } },
			defaultUser: 'appuser',
		});
		const runUser = await resolveContainerRunUser(docker, 'c-appuser');
		expect(runUser).toEqual({ name: 'appuser', uid: 1500, gid: 1500 });
	});

	it('defaults to root (never throws) when docker exec fails', async () => {
		const { docker } = fakeDocker({ throwOnExec: true });
		const runUser = await resolveContainerRunUser(docker, 'c-broken');
		expect(runUser).toEqual({ name: 'root', uid: 0, gid: 0 });
	});

	it('caches the result and re-detects after clearContainerRunUserCache', async () => {
		const { docker, calls } = fakeDocker({});
		await resolveContainerRunUser(docker, 'c-cache');
		const probesAfterFirst = calls.length;
		await resolveContainerRunUser(docker, 'c-cache');
		expect(calls.length).toBe(probesAfterFirst); // cached — no new exec

		clearContainerRunUserCache('c-cache');
		await resolveContainerRunUser(docker, 'c-cache');
		expect(calls.length).toBeGreaterThan(probesAfterFirst); // re-detected
	});
});

describe('chownToRunUser', () => {
	it('chowns the given container paths to the run-user, in-container as root', async () => {
		const { docker, calls } = fakeDocker({});
		await chownToRunUser(
			docker,
			'cid',
			{ name: 'node', uid: 1000, gid: 1000 },
			['/workspace/.hezo/subscription/run-1'],
			{ recursive: true },
		);
		const chown = calls.find((c) => c.Cmd?.[2]?.startsWith('chown'));
		expect(chown).toBeDefined();
		expect(chown?.User).toBe('root');
		expect(chown?.Cmd[2]).toContain('-R');
		expect(chown?.Cmd[2]).toContain("'node':'node'");
		expect(chown?.Cmd[2]).toContain("'/workspace/.hezo/subscription/run-1'");
	});

	it('issues a non-recursive chown without -R', async () => {
		const { docker, calls } = fakeDocker({});
		await chownToRunUser(docker, 'cid', { name: 'node', uid: 1000, gid: 1000 }, ['/workspace']);
		const chown = calls.find((c) => c.Cmd?.[2]?.startsWith('chown'));
		expect(chown?.Cmd[2]).not.toContain('-R');
		expect(chown?.Cmd[2]).toContain("'/workspace'");
	});

	it('is a no-op when the run-user is root', async () => {
		const { docker, calls } = fakeDocker({});
		await chownToRunUser(docker, 'cid', { name: 'root', uid: 0, gid: 0 }, ['/workspace']);
		expect(calls.filter((c) => c.Cmd?.[2]?.startsWith('chown'))).toHaveLength(0);
	});

	it('never throws when the chown exec fails', async () => {
		const { docker } = fakeDocker({ throwOnExec: true });
		await expect(
			chownToRunUser(docker, 'cid', { name: 'node', uid: 1000, gid: 1000 }, ['/workspace']),
		).resolves.toBeUndefined();
	});
});

describe('mkdirInContainer', () => {
	it('runs `mkdir -p` in-container as root for the given paths', async () => {
		const { docker, calls } = fakeDocker({});
		await mkdirInContainer(docker, 'cid', ['/worktrees/TO-9', '/worktrees/TO-10']);
		const mkdir = calls.find((c) => c.Cmd?.[2]?.startsWith('mkdir -p'));
		expect(mkdir).toBeDefined();
		expect(mkdir?.User).toBe('root');
		expect(mkdir?.Cmd[2]).toContain("'/worktrees/TO-9'");
		expect(mkdir?.Cmd[2]).toContain("'/worktrees/TO-10'");
	});

	it('is a no-op with no paths', async () => {
		const { docker, calls } = fakeDocker({});
		await mkdirInContainer(docker, 'cid', []);
		expect(calls.filter((c) => c.Cmd?.[2]?.startsWith('mkdir'))).toHaveLength(0);
	});

	it('never throws when the mkdir exec fails', async () => {
		const { docker } = fakeDocker({ throwOnExec: true });
		await expect(mkdirInContainer(docker, 'cid', ['/worktrees/TO-9'])).resolves.toBeUndefined();
	});
});

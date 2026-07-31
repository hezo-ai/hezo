import type { ContainerEngine } from '../../src/services/sandbox/types';

/** The run-user the stub answers `id -u node …` with (matches the stock agent-base). */
export const STUB_RUN_USER = { name: 'node', uid: 1000, gid: 1000 };

type ExecCreateConfig = Parameters<ContainerEngine['execCreate']>[1];
type ExecStartOpts = Parameters<ContainerEngine['execStart']>[1];

function classify(cmd?: string[]): 'probe' | 'chown' | 'mkdir' | null {
	if (!cmd) return null;
	// Provisioning creates the run directories in-container rather than relying
	// on a bind mount to conjure them, so this fires on every backend - including
	// the ones a unit test fakes. It carries no Env, which is enough on its own
	// to break a recording mock that reads one.
	if (cmd[0] === 'mkdir') return 'mkdir';
	if (cmd[0] !== 'sh' || cmd[1] !== '-c') return null;
	const s = cmd[2] ?? '';
	if (s.startsWith('id -u')) return 'probe';
	if (s.startsWith('chown ')) return 'chown';
	return null;
}

/**
 * Wrap a mock {@link ContainerEngine} so the infrastructure execs Hezo issues -
 * the run-user probe (`id -u node …`), the ownership chowns, and the run-directory
 * `mkdir` - are answered transparently — yielding a
 * `node` run-user and a clean exit — and are NEVER forwarded to the wrapped
 * client's exec handlers. Lets run-user detection work in unit tests (which fake
 * Docker) without polluting tests that record or inspect the agent's own exec.
 * Pass a custom `user` to simulate a different / no-node image.
 */
export function withRunUserStub(
	docker: ContainerEngine,
	user: { name: string; uid: number; gid: number } = STUB_RUN_USER,
): ContainerEngine {
	const infra = new Map<string, 'probe' | 'chown' | 'mkdir'>();
	let seq = 0;
	return {
		...docker,
		execCreate: async (containerId: string, config: ExecCreateConfig) => {
			const kind = classify(config?.Cmd);
			if (kind) {
				const id = `__runuser-${kind}-${seq++}`;
				infra.set(id, kind);
				return id;
			}
			return docker.execCreate(containerId, config);
		},
		execStart: async (execId: string, opts: ExecStartOpts) => {
			const kind = infra.get(execId);
			if (kind === 'probe') {
				return { stdout: `${user.uid}\n${user.gid}\n${user.name}\n`, stderr: '' };
			}
			if (kind === 'chown' || kind === 'mkdir') return { stdout: '', stderr: '' };
			return docker.execStart(execId, opts);
		},
		execInspect: async (execId: string) => {
			if (infra.has(execId)) return { ExitCode: 0, Running: false, Pid: 0 };
			return docker.execInspect(execId);
		},
	} as ContainerEngine;
}

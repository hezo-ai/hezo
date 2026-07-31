import { randomBytes } from 'node:crypto';
import type { ContainerRunUser } from '../container-user';
import { startRunTunnel } from '../sandbox/tunnel/run-tunnel';
import type { ContainerEngine } from '../sandbox/types';
import { CONTAINER_WORKSPACE_ROOT, getRunSocketPath } from '../workspace';
import type { BridgeRunnerArgs } from './relay';
import type { SshAgentServer } from './server';

/** What the bridge needs in order to exist inside a specific container. */
export interface ProvisionBridgeTarget {
	engine: ContainerEngine;
	containerId: string;
	teamId: string;
	dataDir: string;
	runUser: ContainerRunUser;
}

/**
 * Yields the in-container SSH **bridge** descriptor for running git inside the
 * project container outside of an agent run (container provisioning, repo link).
 *
 * Allocates the per-op host TCP listener the bridge runner connects back to -
 * bound to the project's Ed25519 key so `git@github.com:` clones authenticate
 * without ever exposing the private key - then stands up a tunnel so the
 * container can actually reach that listener, and releases both on exit. (Agent
 * runs and chat sessions allocate their own, longer-lived, versions of exactly
 * this pair.)
 *
 * The tunnel is not optional here for the same reason it is not optional
 * anywhere: the listener is on Hezo's loopback, and a container - local daemon
 * or managed sandbox - has no route to it. Only the `ssh` target is pointed
 * anywhere; a provisioning git op has no MCP identity and no egress allocation,
 * so those two keys stay unrouted and a connect to them is refused rather than
 * silently going somewhere.
 */
export async function withProvisionBridge<T>(
	sshAgentServer: SshAgentServer,
	target: ProvisionBridgeTarget,
	fn: (ctx: { bridge: BridgeRunnerArgs; scopeId: string }) => Promise<T>,
): Promise<T> {
	const runId = `provision-${randomBytes(8).toString('hex')}`;
	const socketHostPath = getRunSocketPath(target.dataDir, runId);
	const allocated = await sshAgentServer.allocateRunSocket(
		runId,
		{ teamId: target.teamId, agentId: 'host', label: 'provision-git' },
		socketHostPath,
	);
	let closeTunnel: () => void = () => undefined;
	try {
		const tunnel = await startRunTunnel({
			engine: target.engine,
			containerId: target.containerId,
			runUser: target.runUser,
			files: target.engine.files(target.containerId, CONTAINER_WORKSPACE_ROOT),
			configRelPath: `.hezo/tunnel/${runId}.json`,
			configContainerPath: `${CONTAINER_WORKSPACE_ROOT}/.hezo/tunnel/${runId}.json`,
			addresses: {
				mcp: { host: '127.0.0.1', port: 0 },
				ssh: { host: '127.0.0.1', port: allocated.tcpHostPort },
				proxy: { host: '127.0.0.1', port: 0 },
			},
			policy: { proxiedHosts: [], proxyEverything: false },
		});
		closeTunnel = tunnel.close;
		const bridge: BridgeRunnerArgs = {
			socketPath: `/run/hezo/${runId}.sock`,
			socketUser: target.runUser.name,
			tokenHex: allocated.tokenHex,
			hostName: tunnel.endpoints.sshHost,
			hostPort: tunnel.endpoints.sshPort,
		};
		// The per-op runId doubles as the exec scope marker
		// (`HEZO_HEARTBEAT_RUN_ID`), keeping an abandoned op's process tree
		// killable — see ContainerGitExecutorOptions.scopeId.
		return await fn({ bridge, scopeId: runId });
	} finally {
		closeTunnel();
		await sshAgentServer.releaseRunSocket(runId);
	}
}

import { randomBytes } from 'node:crypto';
import { getRunSocketPath } from '../workspace';
import type { BridgeRunnerArgs } from './relay';
import type { SshAgentServer } from './server';

/**
 * Yields the in-container SSH **bridge** descriptor for running git inside the
 * project container outside of an agent run (container provisioning, repo link).
 * Allocates the per-op host TCP listener the bridge runner connects back to —
 * bound to the project's Ed25519 key so `git@github.com:` clones authenticate
 * without ever exposing the private key — then releases it on exit. (Agent runs
 * allocate their own longer-lived bridge.)
 */
export async function withProvisionBridge<T>(
	sshAgentServer: SshAgentServer,
	teamId: string,
	dataDir: string,
	socketUser: string,
	fn: (ctx: { bridge: BridgeRunnerArgs }) => Promise<T>,
): Promise<T> {
	const runId = `provision-${randomBytes(8).toString('hex')}`;
	const socketHostPath = getRunSocketPath(dataDir, runId);
	const allocated = await sshAgentServer.allocateRunSocket(
		runId,
		{ teamId, agentId: 'host', label: 'provision-git' },
		socketHostPath,
	);
	try {
		const bridge: BridgeRunnerArgs = {
			socketPath: `/run/hezo/${runId}.sock`,
			socketUser,
			tokenHex: allocated.tokenHex,
			hostName: 'host.docker.internal',
			hostPort: allocated.tcpHostPort,
		};
		return await fn({ bridge });
	} finally {
		await sshAgentServer.releaseRunSocket(runId);
	}
}

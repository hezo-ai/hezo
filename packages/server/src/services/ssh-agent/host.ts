import { randomBytes } from 'node:crypto';
import { getRunSocketPath } from '../workspace';
import type { SshAgentServer } from './server';

/**
 * Allocates a short-lived ssh-agent unix socket on the host bound to the
 * project's Ed25519 key, runs `fn` with `SSH_AUTH_SOCK=<socketPath>` in scope,
 * and releases the socket. The same SshAgentServer that signs commits also
 * signs SSH auth challenges, so this socket can authenticate `git@github.com:`
 * clones without ever exposing the private key to the child process.
 */
export async function withHostAgentSocket<T>(
	sshAgentServer: SshAgentServer,
	teamId: string,
	dataDir: string,
	fn: (ctx: { sshAuthSock: string }) => Promise<T>,
): Promise<T> {
	const runId = `host-${randomBytes(8).toString('hex')}`;
	const socketHostPath = getRunSocketPath(dataDir, runId);
	const allocated = await sshAgentServer.allocateRunSocket(
		runId,
		{ teamId, agentId: 'host', label: 'host-git' },
		socketHostPath,
	);
	try {
		return await fn({ sshAuthSock: allocated.socketHostPath });
	} finally {
		await sshAgentServer.releaseRunSocket(runId);
	}
}

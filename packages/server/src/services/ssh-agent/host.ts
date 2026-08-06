import { randomBytes } from 'node:crypto';
import type { Db } from '../../db/database';
import type { ContainerRunUser } from '../container-user';
import { buildEgressProxyEnv, type EgressProxy } from '../egress';
import { startRunTunnel } from '../sandbox/tunnel/run-tunnel';
import { buildTunnelHostPolicy } from '../sandbox/tunnel/split-routing';
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
	/** Reads the vault to derive the tunnel's split-routing policy. */
	db: Db;
	/**
	 * Mandatory, exactly as it is for an agent run.
	 *
	 * A provisioning clone authenticates with a `__HEZO_SECRET_<NAME>__` in its
	 * remote URL, so without a proxy to substitute at there is no credential -
	 * only a placeholder that GitHub rejects as a bad token. Absent one, this
	 * throws rather than standing up a tunnel with nowhere to route.
	 */
	egressProxy: EgressProxy;
	/** Owning project, for the proxy's run-scoped logs. Null for a team-level op. */
	projectId?: string | null;
}

/** What a provisioning git op needs in order to run inside the container. */
export interface ProvisionBridgeContext {
	bridge: BridgeRunnerArgs;
	scopeId: string;
	/**
	 * `HTTP(S)_PROXY`/`NO_PROXY` entries pointing at this op's egress proxy.
	 *
	 * Pass them to the git executor (`ContainerGitExecutor.forPrep`'s `extraEnv`)
	 * or the clone ships its remote's placeholder as a literal Basic password.
	 */
	proxyEnv: string[];
}

/**
 * Yields what a git op needs to run inside the project container outside of an
 * agent run (container provisioning, repo link, reset).
 *
 * Allocates the per-op pair an agent run allocates for itself, just
 * shorter-lived: the host TCP listener the bridge runner connects back to -
 * bound to the project's Ed25519 key, which now signs commits rather than
 * authenticating the transport - and the **egress proxy** that substitutes the
 * clone's credential. Then stands up a tunnel so the container can reach both,
 * and releases all three on exit.
 *
 * The tunnel is not optional here for the same reason it is not optional
 * anywhere: those listeners are on Hezo's loopback, and a container - local
 * daemon or managed sandbox - has no route to them.
 *
 * **The egress leg is not optional either, and used not to exist.** Both
 * non-`mcp` targets are pointed at a real allocation; only `mcp` stays unrouted,
 * because a provisioning git op genuinely has no MCP identity, and a connect
 * there is refused rather than silently going somewhere. When git transport was
 * SSH the bridge carried authentication and no HTTP credential existed, so this
 * op needed no proxy. Under HTTPS the remote carries a
 * `__HEZO_SECRET_<NAME>__` that only the proxy can substitute - so a tunnel
 * without it means every private clone ships the placeholder as its password
 * and is refused upstream as a bad token.
 */
export async function withProvisionBridge<T>(
	sshAgentServer: SshAgentServer,
	target: ProvisionBridgeTarget,
	fn: (ctx: ProvisionBridgeContext) => Promise<T>,
): Promise<T> {
	if (!target.egressProxy) {
		// Named rather than silent: without this the clone still runs, reaches
		// GitHub with an unsubstituted placeholder, and fails as `Invalid username
		// or token` - which sends whoever reads it after the credential, the one
		// thing that is not wrong.
		throw new Error(
			'provisioning git op has no egress proxy allocation; a clone would send its ' +
				'credential placeholder unsubstituted and be refused by the remote',
		);
	}
	const runId = `provision-${randomBytes(8).toString('hex')}`;
	const socketHostPath = getRunSocketPath(target.dataDir, runId);
	const allocated = await sshAgentServer.allocateRunSocket(
		runId,
		{ teamId: target.teamId, agentId: 'host', label: 'provision-git' },
		socketHostPath,
	);
	let closeTunnel: () => void = () => undefined;
	let proxyAllocated = false;
	try {
		// `agentId: 'host'` matches the ssh allocation above: a provisioning op acts
		// for the instance, not for any agent.
		const proxy = await target.egressProxy.allocateRunProxy(runId, {
			teamId: target.teamId,
			agentId: 'host',
			projectId: target.projectId ?? null,
			label: 'provision-git',
		});
		proxyAllocated = true;
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
				proxy: { host: proxy.proxyHost, port: proxy.proxyPort },
			},
			// Derived from the vault, never hand-written - the same single definition
			// the proxy itself matches `allowed_hosts` against, so "would a secret be
			// substituted for this host" and "must this host be proxied" cannot
			// disagree. No descriptors: provisioning loads no connectors.
			policy: await buildTunnelHostPolicy(target.db, []),
		});
		closeTunnel = tunnel.close;
		const bridge: BridgeRunnerArgs = {
			socketPath: `/run/hezo/${runId}.sock`,
			socketUser: target.runUser.name,
			tokenHex: allocated.tokenHex,
			hostName: tunnel.endpoints.sshHost,
			hostPort: tunnel.endpoints.sshPort,
		};
		// The tunnel's container-loopback endpoint, not the host allocation behind
		// it: the container has no route to the latter on any backend.
		const proxyEnv = buildEgressProxyEnv({
			host: tunnel.endpoints.proxyHost,
			port: tunnel.endpoints.proxyPort,
			token: proxy.token,
		});
		// The per-op runId doubles as the exec scope marker
		// (`HEZO_HEARTBEAT_RUN_ID`), keeping an abandoned op's process tree
		// killable — see ContainerGitExecutorOptions.scopeId.
		return await fn({ bridge, scopeId: runId, proxyEnv });
	} finally {
		closeTunnel();
		if (proxyAllocated) await target.egressProxy.releaseRunProxy(runId);
		await sshAgentServer.releaseRunSocket(runId);
	}
}

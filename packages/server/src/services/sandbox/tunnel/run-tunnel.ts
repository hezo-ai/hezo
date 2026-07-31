import { logger } from '../../../logger';
import type { ContainerRunUser } from '../../container-user';
import { type RunEndpoints, tunnelRunEndpoints } from '../endpoints';
import type { SandboxFiles } from '../files';
import type { ContainerByteChannel, ContainerEngine } from '../types';
import { TunnelMux } from './mux';
import { connectToRunTargets, type TargetAddresses } from './net-socket';
import { allocateTunnelPorts } from './ports';
import type { TunnelHostPolicy } from './split-routing';

const log = logger.child('run-tunnel');

/**
 * Starting and stopping the tunnel for one run.
 *
 * This is where the pieces meet: the byte channel the engine opens, the client
 * that runs inside the container, the multiplexer that owns the host-side
 * connections, and the endpoints the run hands to the agent. Kept out of
 * `agent-runner.ts` so the lifecycle - especially teardown - is testable on its
 * own, and so the run path gains one call rather than a block of plumbing.
 */

export interface RunTunnel {
	/** What the run should tell the container to use. All loopback. */
	endpoints: RunEndpoints;
	/** Idempotent. Must be called when the run ends - see the note on {@link startRunTunnel}. */
	close(): void;
}

export interface StartRunTunnelOptions {
	engine: ContainerEngine;
	containerId: string;
	runUser: ContainerRunUser;
	/** Rooted wherever the config file should land; the container reads it back. */
	files: SandboxFiles;
	/** Path of the config file relative to `files`. */
	configRelPath: string;
	/** The same file's absolute path *inside the container*, for the client's argv. */
	configContainerPath: string;
	/** Where each target key lives on the Hezo host, for this run. */
	addresses: TargetAddresses;
	/** Which hosts the container must route through the egress proxy. */
	policy: TunnelHostPolicy;
}

/**
 * Start the tunnel and return the endpoints the run should use.
 *
 * **The returned `close` is not optional.** A live channel counts as activity
 * on every backend, so a tunnel left open keeps the container from ever going
 * idle - and that fails as a bill rather than an error, with nothing to
 * surface it. Callers tear it down on every exit path, and the tests assert it.
 *
 * The client runs unelevated, as the same user the agent does: it only listens
 * on loopback and connects out, so root would buy nothing and would leave a
 * root-owned process in a container the agent otherwise owns.
 */
export async function startRunTunnel(opts: StartRunTunnelOptions): Promise<RunTunnel> {
	// Allocated, not fixed: a container carries several tunnels at once (a run,
	// a chat turn, a provisioning git op), each with its own host-side egress and
	// ssh allocation behind it, so a shared triple would cross them.
	const allocation = allocateTunnelPorts(opts.containerId);
	try {
		await opts.files.write(
			opts.configRelPath,
			JSON.stringify({ ports: allocation.ports, policy: opts.policy }),
		);
	} catch (err) {
		allocation.release();
		throw err;
	}

	let channel: ContainerByteChannel;
	try {
		channel = await opts.engine.openExecChannel(opts.containerId, {
			Cmd: ['hezo-tunnel', opts.configContainerPath],
			User: opts.runUser.name,
			AttachStdout: true,
			AttachStderr: true,
		});
	} catch (err) {
		allocation.release();
		throw err;
	}

	const mux = new TunnelMux(
		{
			write: (data) => channel.write(data),
			close: () => channel.close(),
		},
		connectToRunTargets(opts.addresses),
	);

	channel.onData((chunk) => void mux.handleChunk(chunk));
	// The client writes diagnostics, never protocol bytes, on stderr - so this is
	// the one place a tunnel problem is legible rather than just a dead stream.
	channel.onStderr((chunk) => {
		const text = new TextDecoder().decode(chunk).trim();
		if (text) log.warn(`hezo-tunnel: ${text}`);
	});
	channel.onClose(() => mux.closeAll());

	let closed = false;
	return {
		endpoints: tunnelRunEndpoints(allocation.ports),
		close: () => {
			if (closed) return;
			closed = true;
			// Closing the mux closes the channel, which ends the client's stdin and
			// makes it fail closed on its side too.
			mux.closeAll();
			allocation.release();
		},
	};
}

import { logger } from '../../../logger';
import type { ContainerRunUser } from '../../container-user';
import { type RunEndpoints, tunnelRunEndpoints } from '../endpoints';
import type { SandboxFiles } from '../files';
import { buildAnyPortListeningScript, buildPortsListeningScript } from '../proc-scripts';
import type { ContainerByteChannel, ContainerEngine } from '../types';
import { TunnelMux } from './mux';
import { connectToRunTargets, type TargetAddresses } from './net-socket';
import { allocateFreeTunnelPorts } from './ports';
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
	/**
	 * Called if the tunnel dies **on its own**, before the caller closed it.
	 *
	 * Without this there was no way to find out. The tunnel is the container's
	 * only path to Hezo, so losing it means the agent has no MCP tools, no egress
	 * proxy and no ssh agent for the rest of the run - but the exec kept running,
	 * the container stayed up, and nothing in the run loop ever looked at the
	 * tunnel again after `startRunTunnel` resolved. The run burned its whole
	 * budget and was recorded as having produced no output, which reads as a lazy
	 * model rather than a dead transport.
	 *
	 * Fires at most once, and never for a caller-initiated {@link close} - a
	 * normal run end is not a failure.
	 */
	onClosed(cb: (reason: string) => void): void;
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
	/** Test hook: shortens the wait for the client to bind. */
	listenTimeoutMs?: number;
}

/**
 * Start the tunnel and return the endpoints the run should use.
 *
 * **The endpoints work by the time this resolves.** Opening the channel only
 * starts the client, so this waits for it to bind and **fails the run** if it
 * never does - see {@link waitForTunnelListeners} for why returning early is
 * worse than failing.
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
	//
	// Probed as well as reserved, because the container outlives this process and
	// an abandoned client from a previous life still holds its ports (see
	// `allocateFreeTunnelPorts`). A probe that cannot run is treated as free: the
	// in-process reservation still holds, and a container that will not exec is
	// about to fail the readiness wait below with a better message than a port
	// guess would produce.
	const allocation = await allocateFreeTunnelPorts(opts.containerId, async (ports) => {
		try {
			const exec = await opts.engine.execCreate(opts.containerId, {
				Cmd: ['sh', '-c', buildAnyPortListeningScript([ports.proxy, ports.mcp, ports.ssh])],
				User: 'root',
				AttachStdout: true,
				AttachStderr: false,
			});
			return (await opts.engine.execStart(exec)).stdout.includes('busy');
		} catch {
			return false;
		}
	});
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

	let closed = false;
	let notified = false;
	const closedCallbacks: Array<(reason: string) => void> = [];
	/**
	 * Report an unrequested death, exactly once.
	 *
	 * Guarded on `closed` so a caller's own teardown - which also runs the channel
	 * down - is never mistaken for one. That distinction is the whole point: every
	 * run ends with the tunnel closing, and only the ones that end that way
	 * *first* are failures.
	 */
	const fireClosed = (reason: string) => {
		if (closed || notified) return;
		notified = true;
		log.warn(`tunnel for ${opts.containerId} closed unexpectedly: ${reason}`);
		for (const cb of closedCallbacks) {
			try {
				cb(reason);
			} catch (e) {
				log.error(`tunnel onClosed handler threw: ${(e as Error).message}`);
			}
		}
	};

	const mux = new TunnelMux(
		{
			write: (data) => channel.write(data),
			// Wrapping the mux's close is what catches the framing-error path: a
			// desynchronised stream tears the tunnel down from the inside, and that
			// is just as fatal to the run as the channel dropping.
			close: () => {
				channel.close();
				fireClosed('the tunnel stream desynchronised and was torn down');
			},
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
	channel.onClose(() => {
		// Reported *before* the mux is torn down, and the order is the whole point:
		// `closeAll` closes the channel through the wrapper above, so doing it
		// first would let the mux's own "desynchronised" reason land for what is
		// really a dropped channel. `fireClosed` reports once, so whichever cause
		// is stated first is the one recorded - and this one is the true cause.
		fireClosed('the exec channel carrying the tunnel closed');
		mux.closeAll();
	});

	const close = () => {
		if (closed) return;
		closed = true;
		// Closing the mux closes the channel, which ends the client's stdin and
		// makes it fail closed on its side too.
		mux.closeAll();
		allocation.release();
	};

	try {
		await waitForTunnelListeners(
			opts.engine,
			opts.containerId,
			allocation.ports,
			opts.listenTimeoutMs ?? LISTEN_TIMEOUT_MS,
		);
	} catch (err) {
		close();
		throw err;
	}

	return {
		endpoints: tunnelRunEndpoints(allocation.ports),
		close,
		onClosed: (cb) => {
			closedCallbacks.push(cb);
		},
	};
}

/** How long the in-container client has to bind before the run is failed. */
const LISTEN_TIMEOUT_MS = 30_000;
const LISTEN_POLL_MS = 150;

/**
 * Block until the client is actually listening on its loopback ports.
 *
 * Opening the channel only *starts* the client; it is a process that still has
 * to boot and bind. Returning before it has means handing the run endpoints that
 * refuse connections, and the runtimes dial them immediately - a coding CLI that
 * gets `ECONNREFUSED` on the MCP endpoint marks that server failed **for the
 * whole session** rather than retrying, so the agent runs to completion with no
 * Hezo tools at all and the run reads as the agent having done nothing.
 *
 * Measured on Daytona: the listeners appear ~1s after `openExecChannel` resolves,
 * because the sandbox has to exec a shell, `runuser`, then node. The window is
 * smaller on a local daemon but it is the same race, so the wait is here rather
 * than in either adapter.
 *
 * A timeout **fails the run**. There is no useful degraded mode: without the
 * tunnel the container cannot reach MCP, the egress proxy or the ssh-agent, and
 * proceeding would produce exactly the silent no-op run this exists to prevent.
 */
async function waitForTunnelListeners(
	engine: ContainerEngine,
	containerId: string,
	ports: { proxy: number; mcp: number; ssh: number },
	timeoutMs: number,
): Promise<void> {
	const script = buildPortsListeningScript([ports.proxy, ports.mcp, ports.ssh]);
	const deadline = Date.now() + timeoutMs;
	let lastError = '';
	while (Date.now() < deadline) {
		try {
			const execId = await engine.execCreate(containerId, {
				Cmd: ['sh', '-c', script],
				User: 'root',
				AttachStdout: true,
				AttachStderr: false,
			});
			const { stdout } = await engine.execStart(execId);
			if (stdout.includes('ready')) return;
		} catch (err) {
			// A container that is still settling can refuse an exec; keep trying
			// until the deadline rather than failing on the first one.
			lastError = err instanceof Error ? err.message : String(err);
		}
		await new Promise((resolve) => setTimeout(resolve, LISTEN_POLL_MS));
	}
	throw new Error(
		`the tunnel client did not bind its ports within ${timeoutMs}ms` +
			`${lastError ? ` (last error: ${lastError})` : ''}`,
	);
}

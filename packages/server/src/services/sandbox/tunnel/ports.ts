import { TUNNEL_PORT_BASE, TUNNEL_PORT_RANGE, type TunnelPorts } from '../endpoints';

/**
 * Handing out the loopback ports one tunnel client listens on.
 *
 * The ports sit inside the container's own network namespace, so they can never
 * collide with a host port or with a port in another container. They *can*
 * collide with another tunnel in the **same** container, and a container really
 * does carry more than one at a time: an agent run, a chat turn and a
 * provisioning git op are each their own tunnel, because each has its own
 * host-side egress-proxy and ssh-agent allocation behind it. A fixed triple
 * would have let the first tunnel bind and the second fail, and the second is
 * the one nobody tests.
 *
 * Allocation is per container and in-process only, which rests on one property:
 * a tunnel's client dies with the exec channel that carries it, so a server
 * restart cannot leave a listener behind for this to collide with.
 *
 * **That property is Docker's for free and Daytona's only by construction.**
 * Closing a Daytona PTY socket does not kill what runs on it - measured; only
 * deleting the session does - so the client survives its channel unless that
 * delete lands. It used to be attempted once, in the background, and a failure
 * was logged and forgotten: the orphan then held this container's three ports,
 * and the next run's client died with `EADDRINUSE` having lost MCP and egress
 * for the whole run. The delete is retried now (`deletePtySessionWithRetry`),
 * which is what makes the sentence above true on that backend rather than
 * merely assumed. If a third backend cannot promise it either, this allocator -
 * not that adapter - is what has to change.
 */

/** Ports in one triple. Kept adjacent so a triple is identified by its base. */
const PORTS_PER_TUNNEL = 3;

/** Live bases, keyed by container. Emptied entries are dropped, so this is bounded by live tunnels. */
const taken = new Map<string, Set<number>>();

export class TunnelPortsExhaustedError extends Error {
	constructor(containerId: string) {
		super(`no free tunnel ports left in container ${containerId}`);
		this.name = 'TunnelPortsExhaustedError';
	}
}

export interface AllocatedTunnelPorts {
	ports: TunnelPorts;
	/** Idempotent. Called when the tunnel closes. */
	release(): void;
}

/**
 * Reserve a triple for a new tunnel in `containerId`.
 *
 * Throws rather than reusing a live triple: a silently shared port would make
 * one operation's traffic arrive on another's host-side allocation, crossing a
 * run-scoped egress proxy and a run-scoped ssh-agent token. Failing is the only
 * safe answer, and exhausting {@link TUNNEL_PORT_RANGE} means something is
 * leaking tunnels rather than that the range is too small.
 */
export function allocateTunnelPorts(containerId: string): AllocatedTunnelPorts {
	const inUse = taken.get(containerId) ?? new Set<number>();
	let base = -1;
	for (let p = TUNNEL_PORT_BASE; p < TUNNEL_PORT_BASE + TUNNEL_PORT_RANGE; p += PORTS_PER_TUNNEL) {
		if (!inUse.has(p)) {
			base = p;
			break;
		}
	}
	if (base < 0) throw new TunnelPortsExhaustedError(containerId);
	inUse.add(base);
	taken.set(containerId, inUse);

	let released = false;
	return {
		ports: { proxy: base, mcp: base + 1, ssh: base + 2 },
		release: () => {
			if (released) return;
			released = true;
			const live = taken.get(containerId);
			if (!live) return;
			live.delete(base);
			if (live.size === 0) taken.delete(containerId);
		},
	};
}

/** Test-only: assert the allocator is not leaking triples. */
export function liveTunnelPortCount(containerId?: string): number {
	if (containerId !== undefined) return taken.get(containerId)?.size ?? 0;
	let total = 0;
	for (const set of taken.values()) total += set.size;
	return total;
}

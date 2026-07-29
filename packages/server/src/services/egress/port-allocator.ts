import { createServer } from 'node:net';

export const EGRESS_PORT_RANGE_START = 20000;
export const EGRESS_PORT_RANGE_END = 29999;

// Per-host MITM servers get their own loopback range, separate from the
// front-proxy range above, so per-host churn never contends with front-proxy
// bind attempts and the two allocators never hand out the same port.
export const EGRESS_HOST_PORT_RANGE_START = 30000;
export const EGRESS_HOST_PORT_RANGE_END = 39999;

/**
 * Hand out loopback TCP ports for per-run egress proxies. The allocator
 * remembers the last-used port per `agentId` so debugging sessions land on
 * a stable port across runs of the same agent. When that port is in use
 * (or never seen) it scans the reserved range for a free one.
 */
export class PortAllocator {
	private readonly inUse = new Set<number>();
	/** Where the next scan starts; see allocate(). */
	private cursor = 0;
	private readonly lastForAgent = new Map<string, number>();

	constructor(
		private readonly rangeStart = EGRESS_PORT_RANGE_START,
		private readonly rangeEnd = EGRESS_PORT_RANGE_END,
		private readonly probeAvailability: (port: number) => Promise<boolean> = isPortFree,
	) {}

	async allocate(agentId?: string): Promise<number> {
		// Reserve a candidate synchronously before the async availability probe.
		// The probe yields to the event loop, so without claiming the port first
		// two concurrent allocations would both see it free and return the same
		// port — one run then fails to bind and aborts. Releasing the claim if
		// the probe comes back negative keeps an externally-bound port skippable.
		if (agentId) {
			const previous = this.lastForAgent.get(agentId);
			if (previous !== undefined && !this.inUse.has(previous)) {
				this.inUse.add(previous);
				if (await this.probeAvailability(previous)) {
					return previous;
				}
				this.inUse.delete(previous);
			}
		}
		// Scan from a rotating cursor rather than always from `rangeStart`. Every
		// allocation used to re-probe the low end of the range — a real bind and
		// close per candidate — so a run touching N hosts paid N scans that each
		// walked past the same busy ports. The cursor makes the common case one
		// probe. Wrapping keeps the whole range reachable, so this changes cost,
		// not semantics: the allocate-then-bind race is still handled by the
		// caller's retry loop.
		const span = this.rangeEnd - this.rangeStart + 1;
		for (let i = 0; i < span; i++) {
			const port = this.rangeStart + ((this.cursor + i) % span);
			if (this.inUse.has(port)) continue;
			this.inUse.add(port);
			if (await this.probeAvailability(port)) {
				this.cursor = (port - this.rangeStart + 1) % span;
				if (agentId) this.lastForAgent.set(agentId, port);
				return port;
			}
			this.inUse.delete(port);
		}
		throw new Error(`No free port in range [${this.rangeStart}, ${this.rangeEnd}]`);
	}

	release(port: number): void {
		this.inUse.delete(port);
	}
}

function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once('error', () => {
			resolve(false);
		});
		server.listen({ host: '127.0.0.1', port }, () => {
			server.close(() => resolve(true));
		});
	});
}

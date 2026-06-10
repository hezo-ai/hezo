import { createServer } from 'node:net';

export const EGRESS_PORT_RANGE_START = 20000;
export const EGRESS_PORT_RANGE_END = 29999;

/**
 * Hand out loopback TCP ports for per-run egress proxies. The allocator
 * remembers the last-used port per `agentId` so debugging sessions land on
 * a stable port across runs of the same agent. When that port is in use
 * (or never seen) it scans the reserved range for a free one.
 */
export class PortAllocator {
	private readonly inUse = new Set<number>();
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
		for (let port = this.rangeStart; port <= this.rangeEnd; port++) {
			if (this.inUse.has(port)) continue;
			this.inUse.add(port);
			if (await this.probeAvailability(port)) {
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

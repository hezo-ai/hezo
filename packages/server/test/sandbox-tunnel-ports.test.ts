import { describe, expect, it } from 'vitest';
import { TUNNEL_PORT_BASE, TUNNEL_PORT_RANGE } from '../src/services/sandbox/endpoints';
import {
	allocateFreeTunnelPorts,
	allocateTunnelPorts,
	liveTunnelPortCount,
	TunnelPortsExhaustedError,
} from '../src/services/sandbox/tunnel/ports';

/**
 * The allocator exists because a container carries several tunnels at once - an
 * agent run, a chat turn, a provisioning git op - each pointing at its own
 * host-side egress-proxy and ssh-agent allocation. A shared port triple would
 * route one operation's traffic onto another's run-scoped proxy and ssh token,
 * so these are the properties that keep them apart.
 */
describe('allocateTunnelPorts', () => {
	it('gives concurrent tunnels in one container disjoint ports', () => {
		const a = allocateTunnelPorts('c1');
		const b = allocateTunnelPorts('c1');
		try {
			const all = [...Object.values(a.ports), ...Object.values(b.ports)];
			expect(new Set(all).size).toBe(all.length);
		} finally {
			a.release();
			b.release();
		}
	});

	it('lets different containers reuse the same ports', () => {
		// They are in separate network namespaces, so there is nothing to avoid -
		// and forcing them apart would burn the range for no reason.
		const a = allocateTunnelPorts('c1');
		const b = allocateTunnelPorts('c2');
		try {
			expect(b.ports).toEqual(a.ports);
		} finally {
			a.release();
			b.release();
		}
	});

	it('reuses a triple once it is released', () => {
		const first = allocateTunnelPorts('c1');
		const ports = first.ports;
		first.release();
		const second = allocateTunnelPorts('c1');
		try {
			expect(second.ports).toEqual(ports);
		} finally {
			second.release();
		}
	});

	it('release is idempotent and does not free a later tunnel’s triple', () => {
		const a = allocateTunnelPorts('c1');
		a.release();
		a.release();
		const b = allocateTunnelPorts('c1');
		try {
			a.release();
			// The double release must not have dropped b's reservation, so a third
			// tunnel still has to get a different triple.
			const c = allocateTunnelPorts('c1');
			expect(c.ports).not.toEqual(b.ports);
			c.release();
		} finally {
			b.release();
		}
	});

	it('throws rather than handing out a live triple when the range is full', () => {
		const held = [];
		try {
			for (let i = 0; i < Math.floor(TUNNEL_PORT_RANGE / 3); i++) {
				held.push(allocateTunnelPorts('full'));
			}
			// Sharing a port would cross two runs' egress and ssh scopes, so the
			// only safe answer is to fail - and exhausting the range means
			// something is leaking tunnels, not that the range is too small.
			expect(() => allocateTunnelPorts('full')).toThrow(TunnelPortsExhaustedError);
		} finally {
			for (const h of held) h.release();
		}
	});

	it('keeps every port inside the declared range', () => {
		const a = allocateTunnelPorts('c1');
		try {
			for (const port of Object.values(a.ports)) {
				expect(port).toBeGreaterThanOrEqual(TUNNEL_PORT_BASE);
				expect(port).toBeLessThan(TUNNEL_PORT_BASE + TUNNEL_PORT_RANGE);
			}
		} finally {
			a.release();
		}
	});

	it('draws its range from below the kernel ephemeral floor', () => {
		// The range used to start at 47080, inside Linux's default
		// `net.ipv4.ip_local_port_range` of 32768-60999 - which a fresh network
		// namespace inherits as its own default. An outbound connection the
		// container makes can hold one of these as its *source* port, and the
		// tunnel client's later bind on it then fails. It presented as "the tunnel
		// client did not bind its ports within Nms": intermittent, likelier the
		// busier the container, and reading as an infrastructure flake rather than
		// as the port conflict it was.
		const EPHEMERAL_FLOOR = 32768;
		expect(TUNNEL_PORT_BASE + TUNNEL_PORT_RANGE).toBeLessThan(EPHEMERAL_FLOOR);
		// And still above the well-known ports, which need privilege to bind.
		expect(TUNNEL_PORT_BASE).toBeGreaterThan(1024);
	});

	it('drops a container’s entry entirely once its last tunnel closes', () => {
		// Otherwise the map grows by one entry per container the process ever saw,
		// which is the unbounded-Map failure AGENTS.md names.
		const a = allocateTunnelPorts('transient');
		expect(liveTunnelPortCount('transient')).toBe(1);
		a.release();
		expect(liveTunnelPortCount('transient')).toBe(0);
	});
});

describe('allocateFreeTunnelPorts', () => {
	it('skips a triple something else in the container already holds', async () => {
		// The bug this exists for: the in-process map is empty at startup, but the
		// container outlives the process, so an abandoned client from a previous
		// life is still listening on the first triple.
		const first = allocateTunnelPorts('c1');
		const held = first.ports;
		first.release();

		const a = await allocateFreeTunnelPorts('c1', async (ports) => ports.proxy === held.proxy);
		expect(a.ports.proxy).not.toBe(held.proxy);
		a.release();
	});

	it('releases the triples it probed and refused, so the next caller re-asks', async () => {
		// A refused triple is not poisoned: the orphan holding it may be gone by
		// the time anyone asks again, and the probe is the authority.
		const first = allocateTunnelPorts('c2');
		const held = first.ports;
		first.release();

		let busy = true;
		const a = await allocateFreeTunnelPorts(
			'c2',
			async (ports) => busy && ports.proxy === held.proxy,
		);
		expect(a.ports.proxy).not.toBe(held.proxy);
		a.release();

		busy = false;
		const b = await allocateFreeTunnelPorts('c2', async () => false);
		expect(b.ports.proxy).toBe(held.proxy);
		b.release();
		expect(liveTunnelPortCount('c2')).toBe(0);
	});

	it('still refuses to hand the same triple to two live tunnels', async () => {
		const a = await allocateFreeTunnelPorts('c3', async () => false);
		const b = await allocateFreeTunnelPorts('c3', async () => false);
		expect(b.ports.proxy).not.toBe(a.ports.proxy);
		a.release();
		b.release();
	});

	it('gives every triple back when the container has no room left', async () => {
		// Every triple probes busy, so the loop exhausts the range and throws - and
		// must not leak the reservations it took on the way.
		await expect(allocateFreeTunnelPorts('c4', async () => true)).rejects.toThrow(
			TunnelPortsExhaustedError,
		);
		expect(liveTunnelPortCount('c4')).toBe(0);
	});
});

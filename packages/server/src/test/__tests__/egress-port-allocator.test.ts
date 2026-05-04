import { describe, expect, it } from 'vitest';
import { PortAllocator } from '../../services/egress/port-allocator';

describe('PortAllocator', () => {
	it('hands out the first free port in the range', async () => {
		const allocator = new PortAllocator(20100, 20102, async () => true);
		const a = await allocator.allocate();
		const b = await allocator.allocate();
		const c = await allocator.allocate();
		expect([a, b, c]).toEqual([20100, 20101, 20102]);
	});

	it('skips ports the probe says are unavailable', async () => {
		const taken = new Set([20100, 20101]);
		const allocator = new PortAllocator(20100, 20105, async (p) => !taken.has(p));
		expect(await allocator.allocate()).toBe(20102);
	});

	it('reuses the previous port for the same agent when free', async () => {
		const allocator = new PortAllocator(20100, 20105, async () => true);
		const first = await allocator.allocate('agent-A');
		allocator.release(first);
		const second = await allocator.allocate('agent-A');
		expect(second).toBe(first);
	});

	it('falls back to the next free port when the agent-preferred port is in use', async () => {
		const allocator = new PortAllocator(20100, 20105, async () => true);
		const first = await allocator.allocate('agent-A');
		// Don't release: agent-A's preferred port is in use.
		const second = await allocator.allocate('agent-A');
		expect(second).not.toBe(first);
	});

	it('throws when the entire range is exhausted', async () => {
		const allocator = new PortAllocator(20100, 20100, async () => true);
		await allocator.allocate();
		await expect(allocator.allocate()).rejects.toThrow(/No free port/);
	});
});

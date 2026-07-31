import { describe, expect, it } from 'vitest';
import { INSTANCE_LABEL, reapOrphanedContainers } from '../src/services/sandbox/orphan-reaper';
import { createStubDocker } from './helpers/app';

const INSTANCE = 'inst-aaa';

/** An engine holding `owned` containers under this instance's label. */
function engineWith(owned: string[], opts: { failDestroy?: string[]; listThrows?: boolean } = {}) {
	const destroyed: string[] = [];
	const queried: string[] = [];
	const engine = createStubDocker({
		listContainersByLabel: async (label: string) => {
			queried.push(label);
			if (opts.listThrows) throw new Error('provider unreachable');
			return owned.map((id) => ({ Id: id, Names: [`/hezo-${id}`] }));
		},
		removeContainer: async (id: string) => {
			if (opts.failDestroy?.includes(id)) throw new Error('mid-transition');
			destroyed.push(id);
		},
	});
	return { engine, destroyed, queried };
}

/**
 * The sweep exists because on a managed backend an orphaned sandbox bills until
 * somebody notices - it fails as a cost, not as an error, so nothing surfaces
 * it on its own.
 */
describe('reapOrphanedContainers', () => {
	it('destroys a container no project references any more', async () => {
		const { engine, destroyed } = engineWith(['live-1', 'orphan-1']);
		const result = await reapOrphanedContainers(engine, INSTANCE, new Set(['live-1']));
		expect(destroyed).toEqual(['orphan-1']);
		expect(result.destroyed).toEqual(['orphan-1']);
		expect(result.examined).toBe(2);
	});

	it('never touches a container a project still points at', async () => {
		const { engine, destroyed } = engineWith(['live-1', 'live-2']);
		await reapOrphanedContainers(engine, INSTANCE, new Set(['live-1', 'live-2']));
		expect(destroyed).toEqual([]);
	});

	it('scopes the query to this instance', async () => {
		// The assertion that makes the sweep safe at all: several Hezo instances
		// can share one provider account, and a broader query would destroy
		// another instance's live sandboxes.
		const { engine, queried } = engineWith([]);
		await reapOrphanedContainers(engine, INSTANCE, new Set());
		expect(queried).toEqual([`${INSTANCE_LABEL}=${INSTANCE}`]);
	});

	it('bounds one pass and reports what it deferred', async () => {
		// A recurring job must be bounded, and a silently-truncated sweep reads as
		// "everything was cleaned up" when it was not.
		const orphans = Array.from({ length: 30 }, (_, i) => `orphan-${i}`);
		const { engine, destroyed } = engineWith(orphans);
		const result = await reapOrphanedContainers(engine, INSTANCE, new Set());
		expect(destroyed).toHaveLength(25);
		expect(result.deferred).toBe(5);
	});

	it('keeps sweeping when one destroy fails', async () => {
		// Already gone, or mid-transition and not yet destroyable - the next pass
		// picks it up, and it must not abort the rest.
		const { engine, destroyed } = engineWith(['a', 'b', 'c'], { failDestroy: ['b'] });
		const result = await reapOrphanedContainers(engine, INSTANCE, new Set());
		expect(destroyed).toEqual(['a', 'c']);
		expect(result.destroyed).toEqual(['a', 'c']);
	});

	it('returns no work rather than throwing when the engine is unreachable', async () => {
		// A provider blip must not turn a background tick into a failure.
		const { engine } = engineWith([], { listThrows: true });
		const result = await reapOrphanedContainers(engine, INSTANCE, new Set());
		expect(result).toEqual({ examined: 0, destroyed: [], deferred: 0 });
	});
});

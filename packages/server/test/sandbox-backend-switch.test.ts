import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxBackend } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { SandboxBackendHolder } from '../src/services/sandbox/holder';
import { INSTANCE_LABEL } from '../src/services/sandbox/labels';
import { describeSwitchImpact } from '../src/services/sandbox/switch-backend';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { getOrCreateInstanceId } from '../src/services/telemetry';
import { safeClose } from './helpers';
import { createStubDocker, createTestApp } from './helpers/app';

describe('the switch is scoped to this instance', () => {
	let db: Db;
	const dataDir = mkdtempSync(join(tmpdir(), 'hezo-switch-scope-'));

	beforeAll(async () => {
		db = (await createTestApp()).db;
	});
	afterAll(async () => {
		await safeClose(db);
	});

	it("asks for this instance's containers, not every Hezo container", async () => {
		// The bug: it queried the bare key `hezo.project`. On Daytona a bare key has
		// no server-side equivalent, so the adapter lists **every sandbox in the
		// account** and filters on the key's presence - which every Hezo container
		// everywhere carries. Switching backends destroyed another instance's live
		// sandboxes, which is exactly what labelling by instance exists to prevent.
		const queried: string[] = [];
		const engine = createStubDocker({
			listContainersByLabel: async (label: string) => {
				queried.push(label);
				return [];
			},
		});

		await describeSwitchImpact(db, engine, dataDir);

		const instanceId = await getOrCreateInstanceId(db, dataDir);
		expect(queried).toEqual([`${INSTANCE_LABEL}=${instanceId}`]);
	});
});

/**
 * The backend is switchable at runtime now, and the hazard that creates is a
 * *stale reference*: everything that used to capture the concrete engine at
 * startup - `c.set('docker')`, the JobManager's deps, the chat manager, the
 * process sweeper - would keep driving the backend the operator just left, and
 * a run provisioned there would look entirely normal.
 *
 * So the property under test is not "the holder can swap". It is "a reference
 * taken *before* the swap follows it", because that is the one that fails
 * silently.
 */
describe('SandboxBackendHolder', () => {
	function engineNamed(name: string): { engine: ContainerEngine; calls: string[] } {
		const calls: string[] = [];
		const engine = createStubDocker({
			ping: async () => {
				calls.push(`${name}:ping`);
				return true;
			},
			removeContainer: async (id: string) => {
				calls.push(`${name}:remove:${id}`);
			},
			containerHostMemory: () =>
				name === 'docker' ? { totalRamBytes: 8 * 1024 ** 3, totalSwapBytes: 0 } : null,
		});
		return { engine, calls };
	}

	it('routes a reference captured before the swap to the new backend', async () => {
		const a = engineNamed('docker');
		const b = engineNamed('daytona');
		const holder = new SandboxBackendHolder({
			engine: a.engine,
			info: { backend: SandboxBackend.Docker, display: 'local Docker daemon' },
		});

		// Captured the way every consumer captures it - once, at wiring time.
		const captured = holder.engine;
		await captured.ping();
		expect(a.calls).toEqual(['docker:ping']);

		holder.swap({
			engine: b.engine,
			info: { backend: SandboxBackend.Daytona, display: 'https://app.daytona.io/api' },
		});

		// The same handle, not a re-read one. This is the assertion that matters:
		// if the proxy resolved at capture time rather than at call time, this
		// still hits the old engine and nothing anywhere would report it.
		await captured.ping();
		await captured.removeContainer('ctr-1', true);
		expect(a.calls).toEqual(['docker:ping']);
		expect(b.calls).toEqual(['daytona:ping', 'daytona:remove:ctr-1']);
	});

	it('reports the metadata of whichever backend is current', () => {
		const holder = new SandboxBackendHolder({
			engine: engineNamed('docker').engine,
			info: { backend: SandboxBackend.Docker, display: 'local Docker daemon' },
		});
		expect(holder.backend).toBe(SandboxBackend.Docker);

		holder.swap({
			engine: engineNamed('daytona').engine,
			info: { backend: SandboxBackend.Daytona, display: 'https://app.daytona.io/api' },
		});
		expect(holder.backend).toBe(SandboxBackend.Daytona);
		expect(holder.info.display).toBe('https://app.daytona.io/api');
	});

	it('carries the memory answer across the swap, which is what re-sizes the budget', () => {
		// The capacity model asks the engine where its containers' memory comes
		// from, so switching to a backend that runs elsewhere has to change that
		// answer through the same captured handle - otherwise the budget stays
		// sized for the machine the containers left.
		const holder = new SandboxBackendHolder({
			engine: engineNamed('docker').engine,
			info: { backend: SandboxBackend.Docker, display: 'local Docker daemon' },
		});
		const captured = holder.engine;
		expect(captured.containerHostMemory()).not.toBeNull();

		holder.swap({
			engine: engineNamed('daytona').engine,
			info: { backend: SandboxBackend.Daytona, display: 'https://app.daytona.io/api' },
		});
		expect(captured.containerHostMemory()).toBeNull();
	});
});

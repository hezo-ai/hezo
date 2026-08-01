/**
 * The backend-conformance suites, run against a **real local Docker daemon**.
 *
 * This is the fixture that runs in CI. The suites themselves are generic (see
 * `test/conformance/`) and the paid-provider fixture is manual (`test/live/`),
 * so Docker is what continuously proves the shared assertions are satisfiable at
 * all - a suite only one backend ever runs is a suite that drifts into
 * describing that backend.
 *
 * Self-skips without a daemon or without the agent-base image, matching the
 * other `*-docker.test.ts` suites: CI's `test-backend` job pulls the image, and
 * a fork PR that cannot pull it logs a notice rather than failing the tier.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'vitest';
import { DockerClient } from '../src/services/docker';
import { CONTAINER_WORKSPACE_ROOT } from '../src/services/workspace';
import { describeEngineConformance } from './conformance/engine';
import { describeFilesConformance } from './conformance/files';
import type { LiveAdapterFixture } from './conformance/fixture';

const run = promisify(execFile);

const IMAGE = 'hezo/agent-base:latest';

async function dockerReady(): Promise<string | null> {
	if (process.env.HEZO_SKIP_DOCKER) return 'HEZO_SKIP_DOCKER is set';
	try {
		await run('docker', ['info'], { timeout: 10_000 });
	} catch {
		return 'no Docker daemon reachable';
	}
	try {
		await run('docker', ['image', 'inspect', IMAGE], { timeout: 10_000 });
	} catch {
		return `${IMAGE} not present - build it with \`docker build -t ${IMAGE} -f docker/Dockerfile.agent-base docker\``;
	}
	return null;
}

const skipReason = await dockerReady();

if (skipReason) {
	// A logged skip, never a silent one: a tier that quietly stops exercising the
	// backend it is named for reads as coverage it does not have.
	describe('Docker backend conformance', () => {
		it.skip(`skipped - ${skipReason}`, () => {});
	});
} else {
	const fixture: LiveAdapterFixture = {
		name: 'Docker',
		engine: new DockerClient(),
		image: IMAGE,
		memoryBytes: 2 * 1024 ** 3,
		// Not the bind-mounted `/workspace`: this fixture creates a container with
		// no binds, so the path is inside the container's own writable layer, which
		// is also what makes the disk answer meaningful below.
		workRoot: `${CONTAINER_WORKSPACE_ROOT}/conformance`,
		// A path in the container's own layer shares a device with `/`, so `df`
		// answers - unlike the bind-mounted workspace a real project run uses,
		// where the measurement would be the host partition's and the engine
		// deliberately answers null.
		reportsDiskUsage: true,
		reportsMemoryStats: true,
		honoursExecUser: true,
		runUser: 'node',
	};

	describeEngineConformance(fixture);
	describeFilesConformance(fixture);
}

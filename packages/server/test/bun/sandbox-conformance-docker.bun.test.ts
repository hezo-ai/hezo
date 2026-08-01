/**
 * The backend-conformance suites against a **real local Docker daemon**.
 *
 * In the Bun-native tier, and it has to be: `DockerClient` reaches the daemon
 * with `fetch(..., { unix })`, a Bun-runtime option Node silently ignores - so
 * under vitest every request goes to `http://localhost:80` and is refused. This
 * is the AGENTS.md rule about that tier applied to its own subject: a Node-only
 * test here would not be slower or flakier, it would be impossible.
 *
 * This is the fixture that runs in CI. The suites themselves are generic
 * (`test/conformance/`) and the paid-provider fixture is manual (`test/live/`),
 * so Docker is what continuously proves the shared assertions are satisfiable at
 * all - a suite only one backend ever runs drifts into describing that backend.
 *
 * Self-skips without a daemon or without the agent-base image, matching the
 * other Docker-dependent suites: CI's `test-backend` job pulls the image, and a
 * fork PR that cannot pull it logs a notice rather than failing the tier.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { AiProvider } from '@hezo/shared';
import { DockerClient } from '../../src/services/docker';
import { CONTAINER_WORKSPACE_ROOT } from '../../src/services/workspace';
import { describeAgentCliConformance } from '../conformance/agent-cli';
import { describeEgressConformance } from '../conformance/egress';
import { describeEngineConformance } from '../conformance/engine';
import { describeFilesConformance } from '../conformance/files';
import type {
	ConformanceHarness,
	LiveAdapterFixture,
	LiveModelProvider,
} from '../conformance/fixture';

const IMAGE = 'hezo/agent-base:latest';

const engine = new DockerClient();

/**
 * Probed through the client the suites actually use, not through the `docker`
 * CLI. The two reach the daemon by different means, so a CLI that answers says
 * nothing about whether the client can connect - which is precisely how this
 * suite first went red in CI.
 */
async function skipReason(): Promise<string | null> {
	if (process.env.HEZO_SKIP_DOCKER) return 'HEZO_SKIP_DOCKER is set';
	if (!(await engine.ping().catch(() => false))) return 'no Docker daemon reachable';
	if (!(await engine.imageExists(IMAGE).catch(() => false))) {
		return `${IMAGE} not present - build it with \`docker build -t ${IMAGE} -f docker/Dockerfile.agent-base docker\``;
	}
	return null;
}

const reason = await skipReason();

const harness: ConformanceHarness = { describe, it, expect, beforeAll, afterAll };

if (reason) {
	// A logged skip, never a silent one: a tier that quietly stops exercising the
	// backend it is named for reads as coverage it does not have.
	describe('Docker backend conformance', () => {
		it.skip(`skipped - ${reason}`, () => {});
	});
} else {
	const fixture: LiveAdapterFixture = {
		name: 'Docker',
		engine,
		image: IMAGE,
		memoryBytes: 2 * 1024 ** 3,
		// Not the bind-mounted `/workspace` a project run uses: this fixture creates
		// a container with no binds, so the path is in the container's own writable
		// layer - which is also what makes the disk answer meaningful below.
		workRoot: `${CONTAINER_WORKSPACE_ROOT}/conformance`,
		// A path in the container's own layer shares a device with `/`, so `df`
		// answers. Over a bind mount the engine deliberately answers null, because
		// the measurement would be the host partition's.
		reportsDiskUsage: true,
		reportsMemoryStats: true,
		honoursExecUser: true,
		runUser: 'node',
		// The same opt-in the Daytona fixture takes, wired here too so the agent-CLI
		// suite is not a Daytona-only assertion - a suite one backend ever runs
		// drifts into describing that backend, which is the reason this whole
		// directory is generic. Unset in CI (the key is not a secret there), so it
		// self-skips with a reason and costs nothing; a developer with a key gets a
		// real run against local Docker.
		modelProvider: liveModelProvider(),
	};

	describeEngineConformance(fixture, harness);
	describeFilesConformance(fixture, harness);
	describeAgentCliConformance(fixture, harness);
	describeEgressConformance(fixture, harness);
}

/** Reads the optional model-provider key. Same env contract as `test/live/`. */
function liveModelProvider(): LiveModelProvider | undefined {
	const key = process.env.HEZO_DEEPSEEK_API_KEY;
	if (!key) return undefined;
	return {
		name: 'DeepSeek',
		provider: AiProvider.DeepSeek,
		apiKey: key,
		model: process.env.HEZO_LIVE_MODEL || 'deepseek-v4-flash',
	};
}

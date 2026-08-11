/**
 * The backend-conformance suites, run against a **live Daytona account**.
 *
 * Manual and opt-in. It provisions real sandboxes that cost real money, so it is
 * excluded from the default vitest run (`vitest.config.ts`) and from CI, and
 * runs only through `bun run test:daytona` with a key supplied.
 *
 * It exists because the unit suites cannot answer the question that matters
 * here. They drive a fake API and pin the request shapes Hezo sends; every
 * non-obvious behaviour the adapter encodes was measured against the live API
 * and several contradicted the documentation (no `image` field on create, a
 * build cache keyed on Dockerfile *text*, `stdout`/`stderr` present but always
 * null, a per-exec `user` accepted and ignored). Nothing in a fake notices when
 * one of those changes; this does.
 *
 * The suites are the same ones Docker runs in CI - see `test/conformance/`. That
 * is the point: a divergence shows up as a shared assertion failing on one
 * backend rather than as an assertion nobody wrote for it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaytonaClient, DEFAULT_DAYTONA_API_URL } from '../../src/services/sandbox/daytona/client';
import { DaytonaEngine } from '../../src/services/sandbox/daytona/engine';
import { describeContainerBackendConformance } from '../conformance';
import {
	type ConformanceHarness,
	type LiveAdapterFixture,
	liveModelProviders,
} from '../conformance/fixture';

const apiKey = process.env.HEZO_DAYTONA_API_KEY;
// Model-provider keys are separate from the Daytona key: that one buys a sandbox,
// these buy the completions that prove an agent can actually run in one. Each key
// supplied turns on every CLI that provider can drive; supplying none leaves the
// sandbox suites running alone and the agent-CLI suite self-skipping with a reason.
const modelProviders = liveModelProviders();

if (!apiKey) {
	describe('Daytona backend conformance', () => {
		it.skip('skipped - HEZO_DAYTONA_API_KEY is not set', () => {});
	});
} else {
	const client = new DaytonaClient(
		apiKey,
		process.env.HEZO_DAYTONA_API_URL || DEFAULT_DAYTONA_API_URL,
	);
	const fixture: LiveAdapterFixture = {
		name: 'Daytona',
		engine: new DaytonaEngine(client),
		// A digest, not a tag: Daytona keys its build cache on the Dockerfile text,
		// so a tag is byte-identical forever and would serve a stale snapshot.
		image: process.env.HEZO_CONFORMANCE_IMAGE || 'ghcr.io/hezo-ai/agent-base:latest',
		memoryBytes: 2 * 1024 ** 3,
		workRoot: '/workspace/conformance',
		// Measured: `/workspace` and `/` are the same overlay device on a sandbox,
		// so `df` answers about the sandbox rather than about somebody else's
		// partition - which is what makes the pool's disk-ceiling rung mean
		// something here.
		reportsDiskUsage: true,
		// The API accepts a per-exec `user` and silently ignores it, so the adapter
		// renders a non-root user as `runuser -u <user> --`. From a caller's point
		// of view the identity is still honoured, which is what this asserts.
		honoursExecUser: true,
		runUser: 'node',
		modelProviders,
	};

	const harness: ConformanceHarness = { describe, it, expect, beforeAll, afterAll };
	// One call, deliberately: a suite added to the set reaches this backend
	// without editing this file, and a new adapter cannot register a subset.
	describeContainerBackendConformance(fixture, harness);
}

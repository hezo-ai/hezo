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

import { describe, it } from 'vitest';
import { DaytonaClient, DEFAULT_DAYTONA_API_URL } from '../../src/services/sandbox/daytona/client';
import { DaytonaEngine } from '../../src/services/sandbox/daytona/engine';
import { describeEngineConformance } from '../conformance/engine';
import { describeFilesConformance } from '../conformance/files';
import type { LiveAdapterFixture } from '../conformance/fixture';

const apiKey = process.env.HEZO_DAYTONA_API_KEY;

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
		// Measured, and not what the API surface suggests: the telemetry endpoint
		// answers 403 on an ordinary account ("Telemetry endpoints are disabled when
		// Analytics API is configured"), so `containerStats` is null here. That is
		// the documented optional case - Hezo's graceful stop-before-the-cap does not
		// operate on this backend and Daytona's own OOM handling applies instead,
		// which ends the one run that overran rather than the project's other work.
		reportsMemoryStats: false,
		// The API accepts a per-exec `user` and silently ignores it, so the adapter
		// renders a non-root user as `runuser -u <user> --`. From a caller's point
		// of view the identity is still honoured, which is what this asserts.
		honoursExecUser: true,
		runUser: 'node',
	};

	describeEngineConformance(fixture);
	describeFilesConformance(fixture);
}

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

import { AgentRuntime, AiProvider } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DaytonaClient, DEFAULT_DAYTONA_API_URL } from '../../src/services/sandbox/daytona/client';
import { DaytonaEngine } from '../../src/services/sandbox/daytona/engine';
import { describeContainerBackendConformance } from '../conformance';
import type {
	ConformanceHarness,
	LiveAdapterFixture,
	LiveModelProvider,
} from '../conformance/fixture';

const apiKey = process.env.HEZO_DAYTONA_API_KEY;
// A second, independent key: the Daytona key buys a sandbox, this buys the
// completions that prove an agent can actually run in one. Supplying it turns on
// the agent-CLI suite; without it the sandbox suites run alone and that suite
// self-skips with a reason. DeepSeek because its flash model is the cheapest way
// to buy a real run, and because it runs on two of the CLIs Hezo supports.
const modelKey = process.env.HEZO_DEEPSEEK_API_KEY;
// The cheapest model the provider serves - the suite asks for one word.
const model = process.env.HEZO_LIVE_MODEL || 'deepseek-v4-flash';
// One key, two runtimes. DeepSeek's default is Claude Code (Anthropic-compatible
// endpoint) and it also runs on Prime Agent, so the same credential proves both
// CLIs for the price of a second one-word completion. Prime Agent is named
// explicitly because it is never any provider's default, so nothing else would
// ever exercise it - and its MCP client is Python inside the kernel rather than
// the CLI's own, which is the part no unit test can reach.
const modelProviders: LiveModelProvider[] = modelKey
	? [
			{ name: 'DeepSeek', provider: AiProvider.DeepSeek, apiKey: modelKey, model },
			{
				name: 'DeepSeek',
				provider: AiProvider.DeepSeek,
				runtime: AgentRuntime.PrimeAgent,
				apiKey: modelKey,
				model,
			},
		]
	: [];

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

import { AgentRuntime, AiProvider, PROVIDER_TO_RUNTIME } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { describeAgentCliConformance } from './conformance/agent-cli';
import type {
	ConformanceHarness,
	LiveAdapterFixture,
	LiveModelProvider,
} from './conformance/fixture';

/**
 * Registration-shape coverage for the live agent-CLI suite.
 *
 * The suite itself needs a container, a real backend and a paid completion, so
 * both fixtures self-skip wherever those are absent - which is every CI run and
 * most dev boxes. That leaves the part of it that decides *what gets registered*
 * executed by nothing at all: the per-entry loop, the runtime resolution and the
 * empty-key skip. This drives that half with a recording harness, so a mistake
 * there fails somewhere cheap instead of surviving until someone pays for a live
 * run.
 *
 * Deliberately asserts only registration. Nothing here starts a container: the
 * fake `describe` runs its callback (so the suite body's own registrations are
 * recorded) but never invokes `beforeAll`, which is where every side effect
 * lives.
 */

interface Registered {
	titles: string[];
	skips: string[];
	tests: string[];
}

function recordingHarness(): { harness: ConformanceHarness; registered: Registered } {
	const registered: Registered = { titles: [], skips: [], tests: [] };
	const itFn = ((name: string, _fn?: unknown) => {
		registered.tests.push(name);
	}) as unknown as ConformanceHarness['it'];
	(itFn as unknown as { skip: (name: string, fn?: unknown) => void }).skip = (name: string) => {
		registered.skips.push(name);
	};
	const harness: ConformanceHarness = {
		describe: ((name: string, fn: () => void) => {
			registered.titles.push(name);
			fn();
		}) as unknown as ConformanceHarness['describe'],
		it: itFn,
		expect: expect as unknown as ConformanceHarness['expect'],
		beforeAll: (() => {}) as unknown as ConformanceHarness['beforeAll'],
		afterAll: (() => {}) as unknown as ConformanceHarness['afterAll'],
	};
	return { harness, registered };
}

function fixtureWith(modelProviders: LiveModelProvider[] | undefined): LiveAdapterFixture {
	return {
		name: 'Stub',
		// Never touched: no registered callback that would reach the engine runs here.
		engine: {} as ContainerEngine,
		image: 'stub/agent-base:latest',
		memoryBytes: 1024,
		workRoot: '/workspace/stub',
		reportsDiskUsage: false,
		honoursExecUser: false,
		runUser: 'node',
		...(modelProviders ? { modelProviders } : {}),
	};
}

const KEY = 'sk-not-a-real-key';

describe('describeAgentCliConformance registration', () => {
	it('registers a named skip when the fixture supplies no key', () => {
		const { harness, registered } = recordingHarness();
		describeAgentCliConformance(fixtureWith(undefined), harness);

		expect(registered.titles).toEqual(['Stub: live agent CLI run']);
		// Named, not silent: a suite that quietly registers nothing reads as
		// coverage the run does not have.
		expect(registered.skips.join(' ')).toContain('no model-provider key');
	});

	it('treats an empty provider list the same as none supplied', () => {
		const { harness, registered } = recordingHarness();
		describeAgentCliConformance(fixtureWith([]), harness);
		expect(registered.skips.join(' ')).toContain('no model-provider key');
	});

	it('registers one suite per entry, naming the runtime each resolved to', () => {
		const { harness, registered } = recordingHarness();
		describeAgentCliConformance(
			fixtureWith([
				{ name: 'DeepSeek', provider: AiProvider.DeepSeek, apiKey: KEY },
				{
					name: 'DeepSeek',
					provider: AiProvider.DeepSeek,
					runtime: AgentRuntime.PrimeAgent,
					apiKey: KEY,
				},
			]),
			harness,
		);

		// Two entries, two suites - the whole point of the list. The runtime is in
		// the title so a failure names which CLI broke, not just which backend.
		expect(registered.titles).toEqual([
			`Stub: live agent CLI run (DeepSeek on ${PROVIDER_TO_RUNTIME[AiProvider.DeepSeek]})`,
			`Stub: live agent CLI run (DeepSeek on ${AgentRuntime.PrimeAgent})`,
		]);
	});

	it('falls back to the provider default when an entry names no runtime', () => {
		const { harness, registered } = recordingHarness();
		describeAgentCliConformance(
			fixtureWith([{ name: 'OpenAI', provider: AiProvider.OpenAI, apiKey: KEY }]),
			harness,
		);
		expect(registered.titles[0]).toContain(`on ${PROVIDER_TO_RUNTIME[AiProvider.OpenAI]}`);
		expect(PROVIDER_TO_RUNTIME[AiProvider.OpenAI]).toBe(AgentRuntime.Codex);
	});

	it('registers an unsupported pairing rather than throwing at load time', () => {
		// A throw here would take the whole fixture file down, stopping the engine,
		// files, tunnel, egress and git suites from running at all. The refusal
		// belongs in `beforeAll`, which fails only this suite - so registration has
		// to survive a pairing that cannot work.
		const { harness, registered } = recordingHarness();
		expect(() =>
			describeAgentCliConformance(
				fixtureWith([
					{
						name: 'Anthropic',
						provider: AiProvider.Anthropic,
						runtime: AgentRuntime.Kimi,
						apiKey: KEY,
					},
				]),
				harness,
			),
		).not.toThrow();
		expect(registered.titles).toHaveLength(1);
	});

	it('gives Prime Agent the same assertions as any other runtime', () => {
		// It reports no MCP status of its own, so the two report-reading tests are
		// registered as named skips - but every host-side assertion still runs. A
		// runtime silently exempted from the tool-call assertions would be the one
		// failure this suite exists to catch.
		const { harness, registered } = recordingHarness();
		describeAgentCliConformance(
			fixtureWith([
				{
					name: 'DeepSeek',
					provider: AiProvider.DeepSeek,
					runtime: AgentRuntime.PrimeAgent,
					apiKey: KEY,
				},
			]),
			harness,
		);

		const all = registered.tests.join(' | ');
		expect(all).toContain('reaches Hezo');
		expect(all).toContain('the agent can use one');
		expect(all).toContain('answered, not rejected');
		expect(registered.skips.join(' ')).toContain('reports no MCP server status');
	});
});

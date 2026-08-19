import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	AgentRuntime,
	AI_PROVIDER_INFO,
	AiAuthMethod,
	AiProvider,
	ALL_AI_PROVIDERS,
	PROVIDER_TO_RUNTIME,
	providerRuntimes,
	providerSupportsRuntime,
} from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { describeAgentCliConformance } from './conformance/agent-cli';
import {
	type ConformanceHarness,
	type LiveAdapterFixture,
	type LiveModelProvider,
	liveModelProviders,
	liveProviderEnvVar,
	liveProviderSubscriptionEnvVar,
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
				{ name: 'DeepSeek', provider: AiProvider.DeepSeek, credential: KEY },
				{
					name: 'Moonshot',
					provider: AiProvider.Kimi,
					runtime: AgentRuntime.Kimi,
					credential: KEY,
				},
			]),
			harness,
		);

		// Two entries, two suites - the whole point of the list. The runtime is in
		// the title so a failure names which CLI broke, not just which backend.
		expect(registered.titles).toEqual([
			`Stub: live agent CLI run (DeepSeek on ${PROVIDER_TO_RUNTIME[AiProvider.DeepSeek]})`,
			`Stub: live agent CLI run (Moonshot on ${AgentRuntime.Kimi})`,
		]);
	});

	it('falls back to the provider default when an entry names no runtime', () => {
		const { harness, registered } = recordingHarness();
		describeAgentCliConformance(
			fixtureWith([{ name: 'OpenAI', provider: AiProvider.OpenAI, credential: KEY }]),
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
						credential: KEY,
					},
				]),
				harness,
			),
		).not.toThrow();
		expect(registered.titles).toHaveLength(1);
	});

	it('gives an alternate runtime the same assertions as a default one', () => {
		// A runtime that reports no MCP status of its own gets the two
		// report-reading tests as named skips - but every host-side assertion still
		// runs. A runtime silently exempted from the tool-call assertions would be
		// the one failure this suite exists to catch.
		const { harness, registered } = recordingHarness();
		describeAgentCliConformance(
			fixtureWith([
				{
					name: 'Moonshot',
					provider: AiProvider.Kimi,
					runtime: AgentRuntime.Kimi,
					credential: KEY,
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

/**
 * The provider x CLI matrix builder.
 *
 * Env-gated and derived rather than listed, which is exactly the shape that rots
 * silently: a provider whose key variable is misspelled, or whose runtimes stop
 * being read from production, produces *fewer* combinations rather than an error.
 * These assert the derivation instead of a fixed list, so they stay true as the
 * roster moves.
 */
describe('liveModelProviders', () => {
	/** Run `fn` with only the named live-provider env vars set. */
	function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
		const touched = [
			...Object.keys(vars),
			...Object.keys(process.env).filter(
				(k) => k.startsWith('HEZO_') && (k.endsWith('_API_KEY') || k.endsWith('_BASE_URL')),
			),
		];
		const saved = new Map(touched.map((k) => [k, process.env[k]]));
		for (const k of touched) delete process.env[k];
		Object.assign(process.env, vars);
		try {
			return fn();
		} finally {
			for (const [k, v] of saved) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	}

	it('yields nothing when no key is supplied', () => {
		expect(withEnv({}, liveModelProviders)).toEqual([]);
	});

	it('pairs one key with every CLI that provider can drive', () => {
		const got = withEnv({ HEZO_DEEPSEEK_API_KEY: 'sk-x' }, liveModelProviders);

		// Derived from production, not restated: whatever DeepSeek can run on is
		// what gets covered, so a runtime added to it lands here with no edit.
		expect(got.map((p) => p.runtime)).toEqual([...providerRuntimes(AiProvider.DeepSeek)]);
		expect(new Set(got.map((p) => p.provider))).toEqual(new Set([AiProvider.DeepSeek]));
		expect(got.every((p) => p.credential === 'sk-x')).toBe(true);
		// More than one, so the list really is per-pairing rather than per-provider -
		// the entries a provider-keyed lookup could never have produced.
		expect(got.length).toBe(providerRuntimes(AiProvider.DeepSeek).length);
	});

	it('covers every supported pairing when every key is supplied', () => {
		const all = withEnv(
			Object.fromEntries(
				ALL_AI_PROVIDERS.map((p) => [
					// Named through the builder's own helper: a test that re-derived the
					// spelling would pass while the real variable went unread.
					liveProviderEnvVar(p),
					AI_PROVIDER_INFO[p].local ? 'http://host.docker.internal:1234' : 'sk-x',
				]),
			),
			liveModelProviders,
		);

		const expected = ALL_AI_PROVIDERS.flatMap((p) => providerRuntimes(p).map((r) => `${p}:${r}`));
		expect(all.map((p) => `${p.provider}:${p.runtime}`).sort()).toEqual(expected.sort());
		// Every pairing it emits must be one the provider actually supports, or the
		// suite would refuse it in beforeAll and the matrix would be self-defeating.
		for (const entry of all) {
			expect(
				providerSupportsRuntime(entry.provider, entry.runtime as AgentRuntime),
				`${entry.provider} on ${entry.runtime}`,
			).toBe(true);
		}
	});

	it('gives a local runner its server URL and the documented sentinel', () => {
		const [ollama] = withEnv(
			{ HEZO_OLLAMA_BASE_URL: 'http://host.docker.internal:11434' },
			liveModelProviders,
		);
		// The env var carries a URL, not a key: a local runner authenticates only if
		// the operator turned auth on, and the stored credential is the sentinel.
		expect(ollama.baseUrl).toBe('http://host.docker.internal:11434');
		expect(ollama.credential).toBe(AI_PROVIDER_INFO[AiProvider.Ollama].local?.authTokenSentinel);
	});

	it('lets a per-provider env var override the pinned model', () => {
		const got = withEnv(
			{ HEZO_DEEPSEEK_API_KEY: 'sk-x', HEZO_LIVE_MODEL_DEEPSEEK: 'deepseek-custom' },
			liveModelProviders,
		);
		expect(new Set(got.map((p) => p.model))).toEqual(new Set(['deepseek-custom']));
	});
});

/**
 * The subscription half of the matrix.
 *
 * Worth its own coverage because it is the half that can silently contribute
 * *nothing*: it is gated on a file, on `supportsSubscription`, and on a pairing
 * declaring either a subscription credential variable or a mounted credential
 * file. Any of those going wrong yields fewer combinations rather than an error,
 * which is exactly the failure mode a derived matrix is supposed to remove.
 */
describe('liveModelProviders with subscription credentials', () => {
	/** Blob shapes taken from the production validators, not invented here. */
	const BLOBS: Partial<Record<AiProvider, string>> = {
		[AiProvider.Anthropic]: `sk-ant-oat01-${'x'.repeat(80)}`,
		[AiProvider.OpenAI]: JSON.stringify({
			tokens: { refresh_token: `rt-${'y'.repeat(20)}`, access_token: 'at', account_id: 'a' },
		}),
		// Google is API-key only in Hezo (Antigravity's subscription is not yet
		// deliverable into a run container), so no Google subscription blob here.
	};

	function writeBlob(provider: AiProvider, contents: string): string {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-sub-'));
		const file = join(dir, 'cred');
		writeFileSync(file, contents);
		return file;
	}

	function withSubscription<T>(vars: Record<string, string>, fn: () => T): T {
		const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
		const keys = Object.keys(process.env).filter(
			(k) => k.startsWith('HEZO_') && (k.endsWith('_API_KEY') || k.endsWith('_SUBSCRIPTION_FILE')),
		);
		for (const k of keys) saved.set(k, process.env[k]);
		for (const k of keys) delete process.env[k];
		Object.assign(process.env, vars);
		try {
			return fn();
		} finally {
			for (const [k, v] of saved) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	}

	it('covers exactly the pairings that accept a subscription', () => {
		const vars: Record<string, string> = {};
		for (const [provider, blob] of Object.entries(BLOBS)) {
			vars[liveProviderSubscriptionEnvVar(provider as AiProvider)] = writeBlob(
				provider as AiProvider,
				blob,
			);
		}
		const got = withSubscription(vars, liveModelProviders);

		// One per provider, each on the CLI that provider's subscription actually
		// drives - a pairing with no subscription binding is absent because the
		// derivation excluded it, not because anyone listed it out.
		expect(got.map((p) => `${p.provider}:${p.runtime}`).sort()).toEqual([
			'anthropic:claude_code',
			'openai:codex',
		]);
		expect(got.every((p) => p.authMethod === AiAuthMethod.Subscription)).toBe(true);
	});

	it('carries the blob itself, read from the file', () => {
		const [entry] = withSubscription(
			{
				[liveProviderSubscriptionEnvVar(AiProvider.Anthropic)]: writeBlob(
					AiProvider.Anthropic,
					BLOBS[AiProvider.Anthropic] as string,
				),
			},
			liveModelProviders,
		);
		expect(entry.credential).toBe(BLOBS[AiProvider.Anthropic]);
	});

	it('runs a provider on both auth methods when both are supplied', () => {
		// Not either/or: an api key and a subscription reach the container by
		// genuinely different paths (env var vs mounted file), so both are worth
		// proving and the matrix must not collapse them.
		const got = withSubscription(
			{
				[liveProviderEnvVar(AiProvider.Anthropic)]: 'sk-ant-key',
				[liveProviderSubscriptionEnvVar(AiProvider.Anthropic)]: writeBlob(
					AiProvider.Anthropic,
					BLOBS[AiProvider.Anthropic] as string,
				),
			},
			liveModelProviders,
		);
		const onClaudeCode = got.filter((p) => p.runtime === AgentRuntime.ClaudeCode);
		expect(onClaudeCode.map((p) => p.authMethod).sort()).toEqual([
			AiAuthMethod.ApiKey,
			AiAuthMethod.Subscription,
		]);
	});

	it('refuses a blob of the wrong shape, naming the variable', () => {
		const file = writeBlob(AiProvider.OpenAI, '{"not":"a codex auth.json"}');
		expect(
			() =>
				withSubscription({ [liveProviderSubscriptionEnvVar(AiProvider.OpenAI)]: file }, () =>
					liveModelProviders(),
				),
			// Production's own validator, so a bad paste fails here with the message
			// the add-provider route would give rather than as an opaque CLI auth
			// error inside a sandbox ten minutes later.
		).toThrow(/HEZO_OPENAI_SUBSCRIPTION_FILE/);
	});

	it('refuses an unreadable file rather than running without the credential', () => {
		expect(() =>
			withSubscription(
				{ [liveProviderSubscriptionEnvVar(AiProvider.OpenAI)]: '/nonexistent/creds.json' },
				() => liveModelProviders(),
			),
		).toThrow(/could not be read/);
	});

	it('ignores a subscription file for a provider that has no subscription flow', () => {
		// DeepSeek is api-key only. Honouring the variable would fabricate a pairing
		// production cannot configure.
		const got = withSubscription(
			{ HEZO_DEEPSEEK_SUBSCRIPTION_FILE: writeBlob(AiProvider.DeepSeek, 'anything') },
			liveModelProviders,
		);
		expect(got).toEqual([]);
	});
});

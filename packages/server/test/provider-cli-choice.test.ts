import {
	AGENT_RUNTIME_LABELS,
	AgentRuntime,
	AiAuthMethod,
	AiProvider,
	ALL_AI_PROVIDERS,
	effectiveRuntime,
	PROVIDER_TO_RUNTIME,
	PROVIDERS_BY_RUNTIME,
	providerRuntimeBinding,
	providerRuntimes,
	providerSupportsRuntime,
} from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { buildProviderEnv } from '../src/services/agent-runner';
import {
	getProviderCredentialAndModel,
	storeAiProviderKey,
	updateAiProviderConfig,
} from '../src/services/ai-provider-keys';
import { resolveRuntimeForTask } from '../src/services/runtime-resolver';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: Db;
let masterKeyManager: MasterKeyManager;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	await db.query(`DELETE FROM ai_provider_configs`);
});

/** Read the value of one env entry out of `buildProviderEnv`'s `KEY=value` list. */
function envValue(entries: string[], key: string): string | undefined {
	const hit = entries.find((e) => e.startsWith(`${key}=`));
	return hit === undefined ? undefined : hit.slice(key.length + 1);
}

describe('provider runtime roster', () => {
	it('lists the default runtime first for every provider', () => {
		for (const provider of ALL_AI_PROVIDERS) {
			const runtimes = providerRuntimes(provider);
			expect(runtimes.length).toBeGreaterThan(0);
			expect(runtimes[0]).toBe(PROVIDER_TO_RUNTIME[provider]);
			// No duplicates — an alternate that repeats the default would render the
			// same CLI twice in the picker.
			expect(new Set(runtimes).size).toBe(runtimes.length);
		}
	});

	it('offers Moonshot both of its CLIs from one provider', () => {
		// The pair used to be two providers; now it is one offering both, with the
		// default first.
		expect(providerRuntimes(AiProvider.Kimi)).toEqual([AgentRuntime.ClaudeCode, AgentRuntime.Kimi]);
	});

	it('advertises no CLI a provider cannot authenticate', () => {
		// The rule an alternate runtime has to keep: a provider only offers a CLI it
		// has a credential binding for, so the picker can never present one whose
		// run would fail at auth.
		for (const provider of ALL_AI_PROVIDERS) {
			for (const runtime of Object.values(AgentRuntime)) {
				expect(providerRuntimes(provider).includes(runtime), `${provider} on ${runtime}`).toBe(
					providerSupportsRuntime(provider, runtime),
				);
			}
		}
	});

	it('exposes an env binding for every advertised pairing', () => {
		for (const provider of ALL_AI_PROVIDERS) {
			for (const runtime of providerRuntimes(provider)) {
				const binding = providerRuntimeBinding(provider, runtime);
				expect(binding, `${provider} on ${runtime}`).not.toBeNull();
				// A binding with no credential variable could never deliver the key.
				expect(Object.keys(binding?.credentialEnvByAuthMethod ?? {}).length).toBeGreaterThan(0);
			}
		}
	});

	it('returns no binding for an unsupported pairing', () => {
		expect(providerSupportsRuntime(AiProvider.Anthropic, AgentRuntime.Kimi)).toBe(false);
		expect(providerRuntimeBinding(AiProvider.Anthropic, AgentRuntime.Kimi)).toBeNull();
	});

	it('lists a multi-runtime provider under each of its runtimes', () => {
		expect(PROVIDERS_BY_RUNTIME[AgentRuntime.ClaudeCode]).toContain(AiProvider.Kimi);
		expect(PROVIDERS_BY_RUNTIME[AgentRuntime.Kimi]).toContain(AiProvider.Kimi);
	});

	it('names every runtime for the picker', () => {
		for (const runtime of Object.values(AgentRuntime)) {
			expect(AGENT_RUNTIME_LABELS[runtime]?.length ?? 0).toBeGreaterThan(0);
		}
	});
});

describe('effectiveRuntime', () => {
	it('falls back to the provider default when nothing is stored', () => {
		expect(effectiveRuntime(AiProvider.Kimi, null)).toBe(AgentRuntime.ClaudeCode);
		expect(effectiveRuntime(AiProvider.OpenAI, null)).toBe(AgentRuntime.Codex);
	});

	it('honours a supported stored choice', () => {
		expect(effectiveRuntime(AiProvider.Kimi, AgentRuntime.Kimi)).toBe(AgentRuntime.Kimi);
	});

	it('degrades to the default when the stored choice is no longer supported', () => {
		// A roster change under an existing row must not strand the credential.
		expect(effectiveRuntime(AiProvider.Anthropic, AgentRuntime.Kimi)).toBe(AgentRuntime.ClaudeCode);
	});
});

describe('buildProviderEnv follows the credential runtime', () => {
	const credential = { value: 'sk-moonshot', authMethod: AiAuthMethod.ApiKey, baseUrl: null };

	it('builds the Claude Code bag for a Kimi credential on its default', () => {
		const env = buildProviderEnv(AiProvider.Kimi, { ...credential, runtime: null });
		expect(envValue(env, 'ANTHROPIC_AUTH_TOKEN')).toBe('sk-moonshot');
		expect(envValue(env, 'ANTHROPIC_BASE_URL')).toBe('https://api.moonshot.ai/anthropic');
		// The Kimi Code family must be absent, or the wrong CLI's config activates.
		expect(envValue(env, 'KIMI_MODEL_API_KEY')).toBeUndefined();
		expect(envValue(env, 'KIMI_MODEL_NAME')).toBeUndefined();
	});

	it('builds the Kimi Code bag for the same credential switched to the native CLI', () => {
		const env = buildProviderEnv(AiProvider.Kimi, { ...credential, runtime: AgentRuntime.Kimi });
		expect(envValue(env, 'KIMI_MODEL_API_KEY')).toBe('sk-moonshot');
		expect(envValue(env, 'KIMI_MODEL_BASE_URL')).toBe('https://api.moonshot.ai/v1');
		expect(envValue(env, 'KIMI_MODEL_NAME')).toBeTruthy();
		expect(envValue(env, 'ANTHROPIC_AUTH_TOKEN')).toBeUndefined();
		expect(envValue(env, 'ANTHROPIC_BASE_URL')).toBeUndefined();
	});

	it('carries the quiet-env bag only on the runtime that needs it', () => {
		const onClaude = buildProviderEnv(AiProvider.Kimi, { ...credential, runtime: null });
		expect(envValue(onClaude, 'DISABLE_TELEMETRY')).toBe('1');
		const onKimi = buildProviderEnv(AiProvider.Kimi, {
			...credential,
			runtime: AgentRuntime.Kimi,
		});
		expect(envValue(onKimi, 'DISABLE_TELEMETRY')).toBeUndefined();
		expect(envValue(onKimi, 'KIMI_DISABLE_TELEMETRY')).toBe('1');
	});

	it('routes the run model into the variable that runtime actually reads', () => {
		const onKimi = buildProviderEnv(
			AiProvider.Kimi,
			{ ...credential, runtime: AgentRuntime.Kimi },
			'kimi-k3',
		);
		// Kimi Code selects from KIMI_MODEL_NAME, not only from --model.
		expect(envValue(onKimi, 'KIMI_MODEL_NAME')).toBe('kimi-k3');

		const onClaude = buildProviderEnv(
			AiProvider.Kimi,
			{ ...credential, runtime: AgentRuntime.ClaudeCode },
			'kimi-k3',
		);
		// A third-party Anthropic-compatible endpoint tracks the run model for
		// subagents rather than pinning the stale constant.
		expect(envValue(onClaude, 'CLAUDE_CODE_SUBAGENT_MODEL')).toBe('kimi-k3');
	});
});

describe('credential lookup and runtime resolution', () => {
	it('resolves a stored choice through the credential', async () => {
		const configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Kimi,
			'sk-moonshot',
			AiAuthMethod.ApiKey,
			'kimi',
			{},
			AgentRuntime.Kimi,
		);
		expect(configId).toBeTruthy();

		const credential = await getProviderCredentialAndModel(db, masterKeyManager, AiProvider.Kimi);
		expect(credential?.runtime).toBe(AgentRuntime.Kimi);

		const resolved = await resolveRuntimeForTask(db, null);
		expect(resolved).toEqual({ ok: true, runtime: AgentRuntime.Kimi, provider: AiProvider.Kimi });
	});

	it('defaults to the provider runtime when the credential stores none', async () => {
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Kimi,
			'sk-moonshot',
			AiAuthMethod.ApiKey,
			'kimi',
		);
		const credential = await getProviderCredentialAndModel(db, masterKeyManager, AiProvider.Kimi);
		expect(credential?.runtime).toBeNull();
		expect(await resolveRuntimeForTask(db, null)).toEqual({
			ok: true,
			runtime: AgentRuntime.ClaudeCode,
			provider: AiProvider.Kimi,
		});
	});

	it('picks the credential matching a task-pinned runtime, not merely the first', async () => {
		// The default-priority credential runs on Claude Code; only the second one
		// satisfies a task pinned to the native CLI. Selecting by provider alone
		// would return the first and launch the wrong binary.
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Kimi,
			'sk-on-claude',
			AiAuthMethod.ApiKey,
			'kimi-claude',
		);
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Kimi,
			'sk-on-kimi',
			AiAuthMethod.ApiKey,
			'kimi-native',
			{},
			AgentRuntime.Kimi,
		);

		expect(await resolveRuntimeForTask(db, AgentRuntime.Kimi)).toEqual({
			ok: true,
			runtime: AgentRuntime.Kimi,
			provider: AiProvider.Kimi,
		});

		const forKimi = await getProviderCredentialAndModel(
			db,
			masterKeyManager,
			AiProvider.Kimi,
			AgentRuntime.Kimi,
		);
		expect(forKimi?.value).toBe('sk-on-kimi');

		const forClaude = await getProviderCredentialAndModel(
			db,
			masterKeyManager,
			AiProvider.Kimi,
			AgentRuntime.ClaudeCode,
		);
		expect(forClaude?.value).toBe('sk-on-claude');
	});

	it('returns no credential when none runs on the requested CLI', async () => {
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'sk-ant-key',
			AiAuthMethod.ApiKey,
			'anthropic',
		);
		expect(
			await getProviderCredentialAndModel(
				db,
				masterKeyManager,
				AiProvider.Anthropic,
				AgentRuntime.Kimi,
			),
		).toBeNull();
	});

	it('round-trips a runtime change through the update path', async () => {
		const configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Kimi,
			'sk-moonshot',
			AiAuthMethod.ApiKey,
			'kimi',
		);

		expect(await updateAiProviderConfig(db, configId, { runtime: AgentRuntime.Kimi })).toBe(true);
		expect(
			(await getProviderCredentialAndModel(db, masterKeyManager, AiProvider.Kimi))?.runtime,
		).toBe(AgentRuntime.Kimi);

		// Clearing back to null restores "follow the provider default".
		expect(await updateAiProviderConfig(db, configId, { runtime: null })).toBe(true);
		const cleared = await getProviderCredentialAndModel(db, masterKeyManager, AiProvider.Kimi);
		expect(cleared?.runtime).toBeNull();
		expect(effectiveRuntime(AiProvider.Kimi, cleared?.runtime ?? null)).toBe(
			AgentRuntime.ClaudeCode,
		);
	});
});

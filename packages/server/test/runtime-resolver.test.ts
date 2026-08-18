import { AgentRuntime, AiAuthMethod, AiProvider, AiProviderStatus } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { setDefaultAiProvider, storeAiProviderKey } from '../src/services/ai-provider-keys';
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

describe('resolveRuntimeForTask', () => {
	it('reports why nothing could be resolved when no providers are configured', async () => {
		const none = await resolveRuntimeForTask(db, null);
		expect(none.ok).toBe(false);
		expect(none.ok === false && none.reason).toContain('No verified AI provider credential');

		const pinned = await resolveRuntimeForTask(db, AgentRuntime.Codex);
		expect(pinned.ok).toBe(false);
		expect(pinned.ok === false && pinned.reason).toContain('pinned to the "codex" runtime');
	});

	it('returns runtime + provider when an explicit task runtime matches a configured provider', async () => {
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			'sk-openai-api',
			AiAuthMethod.ApiKey,
			'openai-api',
		);

		expect(await resolveRuntimeForTask(db, AgentRuntime.Codex)).toEqual({
			ok: true,
			runtime: AgentRuntime.Codex,
			provider: AiProvider.OpenAI,
		});
		expect((await resolveRuntimeForTask(db, AgentRuntime.ClaudeCode)).ok).toBe(false);
	});

	it('picks the runtime whose provider is marked default when multiple configs coexist', async () => {
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			'sk-openai-api',
			AiAuthMethod.ApiKey,
			'openai-api',
		);
		const subscriptionId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			JSON.stringify({ tokens: { refresh_token: 'rt-x' } }),
			AiAuthMethod.Subscription,
			'openai-subscription',
		);

		const first = await resolveRuntimeForTask(db, null);
		expect(first.ok === true && first.runtime).toBe(AgentRuntime.Codex);

		await setDefaultAiProvider(db, subscriptionId);
		const second = await resolveRuntimeForTask(db, null);
		expect(second.ok === true && second.runtime).toBe(AgentRuntime.Codex);
	});

	it('falls back to the oldest active provider when none is marked default', async () => {
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			'sk-openai-one',
			AiAuthMethod.ApiKey,
			'openai-one',
		);
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Google,
			'AIza-two',
			AiAuthMethod.ApiKey,
			'google-two',
		);

		// Backdated so "oldest" is a fact rather than a tie: both inserts can land in
		// the same millisecond, and the assertion is about age, not about which of two
		// equally-aged rows the database happens to return first.
		await db.query(
			`UPDATE ai_provider_configs
			    SET is_default = false,
			        created_at = CASE WHEN provider = $1 THEN now() - interval '1 hour' ELSE now() END`,
			[AiProvider.OpenAI],
		);

		expect(await resolveRuntimeForTask(db, null)).toEqual({
			ok: true,
			runtime: AgentRuntime.Codex,
			provider: AiProvider.OpenAI,
		});
	});

	it('disambiguates between providers that share a runtime by is_default and creation order', async () => {
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'sk-ant-key',
			AiAuthMethod.ApiKey,
			'anthropic-primary',
		);
		const deepseekId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.DeepSeek,
			'sk-deepseek',
			AiAuthMethod.ApiKey,
			'deepseek-primary',
		);

		// Anthropic was added first, so it holds the single instance-wide default and
		// wins the shared ClaudeCode runtime on is_default DESC.
		expect(await resolveRuntimeForTask(db, AgentRuntime.ClaudeCode)).toEqual({
			ok: true,
			runtime: AgentRuntime.ClaudeCode,
			provider: AiProvider.Anthropic,
		});

		// Make deepseek the global default so it wins on is_default DESC.
		await setDefaultAiProvider(db, deepseekId);

		expect(await resolveRuntimeForTask(db, AgentRuntime.ClaudeCode)).toEqual({
			ok: true,
			runtime: AgentRuntime.ClaudeCode,
			provider: AiProvider.DeepSeek,
		});
	});

	it('resolves z.ai to the ClaudeCode runtime', async () => {
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.ZAi,
			'zai-key',
			AiAuthMethod.ApiKey,
			'zai-primary',
		);

		expect(await resolveRuntimeForTask(db, AgentRuntime.ClaudeCode)).toEqual({
			ok: true,
			runtime: AgentRuntime.ClaudeCode,
			provider: AiProvider.ZAi,
		});
		expect((await resolveRuntimeForTask(db, AgentRuntime.Codex)).ok).toBe(false);
	});

	it('moves every unpinned run onto the new default the moment it changes', async () => {
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.DeepSeek,
			'sk-deepseek',
			AiAuthMethod.ApiKey,
			'deepseek',
		);
		const openaiId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			'sk-openai',
			AiAuthMethod.ApiKey,
			'openai',
		);

		// Adding a credential does not make it the default — only the first config on
		// a fresh instance auto-takes the flag.
		expect(await resolveRuntimeForTask(db, null)).toEqual({
			ok: true,
			runtime: AgentRuntime.ClaudeCode,
			provider: AiProvider.DeepSeek,
		});

		await setDefaultAiProvider(db, openaiId);

		expect(await resolveRuntimeForTask(db, null)).toEqual({
			ok: true,
			runtime: AgentRuntime.Codex,
			provider: AiProvider.OpenAI,
		});
	});

	it('fails rather than silently running an unusable default on another credential', async () => {
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.DeepSeek,
			'sk-deepseek',
			AiAuthMethod.ApiKey,
			'deepseek',
		);
		const openaiId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			'sk-openai',
			AiAuthMethod.ApiKey,
			'openai',
		);
		await setDefaultAiProvider(db, openaiId);
		// The operator's designated default stops being usable (a revoked key that a
		// later Verify marked invalid). The settings page still shows it as Default.
		await db.query(`UPDATE ai_provider_configs SET status = $1 WHERE id = $2`, [
			AiProviderStatus.Invalid,
			openaiId,
		]);

		const resolved = await resolveRuntimeForTask(db, null);
		// Not DeepSeek: handing the run to the previous default is the silent
		// substitution this guards against.
		expect(resolved.ok).toBe(false);
		expect(resolved.ok === false && resolved.reason).toContain('openai');
		expect(resolved.ok === false && resolved.reason).toContain('invalid');
	});

	it('still runs on the oldest verified credential when no default is designated', async () => {
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.DeepSeek,
			'sk-deepseek',
			AiAuthMethod.ApiKey,
			'deepseek',
		);
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			'sk-openai',
			AiAuthMethod.ApiKey,
			'openai',
		);
		// No row carries the flag — nothing was designated, so nothing is being
		// substituted for and the oldest verified credential is the honest answer.
		// Backdated for the same reason as above: two inserts can share a millisecond,
		// and this asserts on age rather than on tie-breaking order.
		await db.query(
			`UPDATE ai_provider_configs
			    SET is_default = false,
			        created_at = CASE WHEN provider = $1 THEN now() - interval '1 hour' ELSE now() END`,
			[AiProvider.DeepSeek],
		);

		expect(await resolveRuntimeForTask(db, null)).toEqual({
			ok: true,
			runtime: AgentRuntime.ClaudeCode,
			provider: AiProvider.DeepSeek,
		});
	});
});

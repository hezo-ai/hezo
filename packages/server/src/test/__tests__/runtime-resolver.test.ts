import type { PGlite } from '@electric-sql/pglite';
import { AgentRuntime, AiAuthMethod, AiProvider } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import { setDefaultAiProvider, storeAiProviderKey } from '../../services/ai-provider-keys';
import { resolveRuntimeForIssue } from '../../services/runtime-resolver';
import { safeClose } from '../helpers';
import { createTestApp } from '../helpers/app';

let db: PGlite;
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

describe('resolveRuntimeForIssue', () => {
	it('returns null when no providers are configured', async () => {
		expect(await resolveRuntimeForIssue(db, null)).toBeNull();
		expect(await resolveRuntimeForIssue(db, AgentRuntime.Codex)).toBeNull();
	});

	it('returns runtime + provider when an explicit issue runtime matches a configured provider', async () => {
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			'sk-openai-api',
			AiAuthMethod.ApiKey,
			'openai-api',
		);

		expect(await resolveRuntimeForIssue(db, AgentRuntime.Codex)).toEqual({
			runtime: AgentRuntime.Codex,
			provider: AiProvider.OpenAI,
		});
		expect(await resolveRuntimeForIssue(db, AgentRuntime.ClaudeCode)).toBeNull();
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

		expect((await resolveRuntimeForIssue(db, null))?.runtime).toBe(AgentRuntime.Codex);

		await setDefaultAiProvider(db, subscriptionId);
		expect((await resolveRuntimeForIssue(db, null))?.runtime).toBe(AgentRuntime.Codex);
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

		await db.query(`UPDATE ai_provider_configs SET is_default = false`);

		expect(await resolveRuntimeForIssue(db, null)).toEqual({
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
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.DeepSeek,
			'sk-deepseek',
			AiAuthMethod.ApiKey,
			'deepseek-primary',
		);

		// Both providers ship a default row of their own; tiebreak goes to whichever
		// was added first under the same runtime.
		expect(await resolveRuntimeForIssue(db, AgentRuntime.ClaudeCode)).toEqual({
			runtime: AgentRuntime.ClaudeCode,
			provider: AiProvider.Anthropic,
		});

		// Demote anthropic so deepseek wins on is_default DESC.
		await db.query(
			`UPDATE ai_provider_configs SET is_default = false WHERE provider = 'anthropic'`,
		);

		expect(await resolveRuntimeForIssue(db, AgentRuntime.ClaudeCode)).toEqual({
			runtime: AgentRuntime.ClaudeCode,
			provider: AiProvider.DeepSeek,
		});
	});
});

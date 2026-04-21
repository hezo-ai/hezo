import type { PGlite } from '@electric-sql/pglite';
import { AiAuthMethod, AiProvider } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import {
	deleteAiProviderConfig,
	getAiProviderStatus,
	getProviderCredential,
	listAiProviders,
	setDefaultAiProvider,
	storeAiProviderKey,
} from '../../services/ai-provider-keys';
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

describe('storeAiProviderKey', () => {
	it('stores an API key and returns config id', async () => {
		const configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'sk-ant-test-key-123',
			AiAuthMethod.ApiKey,
			'anthropic-primary',
		);
		expect(configId).toBeDefined();
		expect(typeof configId).toBe('string');
	});

	it('auto-defaults the first config for a provider', async () => {
		const configs = await listAiProviders(db);
		const anthropicConfig = configs.find((c) => c.provider === AiProvider.Anthropic);
		expect(anthropicConfig).toBeDefined();
		expect(anthropicConfig?.is_default).toBe(true);
	});

	it('does not auto-default subsequent configs for same provider', async () => {
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'sk-ant-second-key-456',
			AiAuthMethod.ApiKey,
			'anthropic-secondary',
		);

		const configs = await listAiProviders(db);
		const anthropicConfigs = configs.filter((c) => c.provider === AiProvider.Anthropic);
		expect(anthropicConfigs.length).toBe(2);
		const defaults = anthropicConfigs.filter((c) => c.is_default);
		expect(defaults.length).toBe(1);
	});

	it('inlines an encrypted credential on the config row', async () => {
		const result = await db.query<{ encrypted_credential: string }>(
			`SELECT encrypted_credential
			 FROM ai_provider_configs
			 WHERE provider = $1::ai_provider AND label = $2
			 LIMIT 1`,
			[AiProvider.Anthropic, 'anthropic-primary'],
		);
		expect(result.rows.length).toBe(1);
		expect(result.rows[0].encrypted_credential).toBeTruthy();
		expect(result.rows[0].encrypted_credential).not.toContain('sk-ant-test-key-123');
	});

	it('auto-derives a label when none is provided', async () => {
		const configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Moonshot,
			'sk-moonshot-test',
			AiAuthMethod.ApiKey,
		);
		const configs = await listAiProviders(db);
		const created = configs.find((c) => c.id === configId);
		expect(created).toBeDefined();
		expect(created?.label).toBe(AiProvider.Moonshot);
	});

	it('stores metadata when provided', async () => {
		const configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			'sk-openai-test-key',
			AiAuthMethod.ApiKey,
			'openai-primary',
			{ source: 'test' },
		);
		const configs = await listAiProviders(db);
		const openaiConfig = configs.find((c) => c.id === configId);
		expect(openaiConfig).toBeDefined();
		expect(openaiConfig?.metadata).toEqual({ source: 'test' });
	});
});

describe('getProviderCredential', () => {
	it('decrypts and returns the default config credential', async () => {
		const credential = await getProviderCredential(db, masterKeyManager, AiProvider.Anthropic);
		expect(credential).toBeDefined();
		expect(credential?.value).toBe('sk-ant-test-key-123');
		expect(credential?.authMethod).toBe(AiAuthMethod.ApiKey);
	});

	it('returns null for unconfigured provider', async () => {
		const credential = await getProviderCredential(db, masterKeyManager, AiProvider.Google);
		expect(credential).toBeNull();
	});
});

describe('listAiProviders', () => {
	it('returns all configs instance-wide', async () => {
		const configs = await listAiProviders(db);
		expect(configs.length).toBeGreaterThanOrEqual(3);
	});

	it('does not expose encrypted credential values', async () => {
		const configs = await listAiProviders(db);
		for (const config of configs) {
			const configAny = config as unknown as Record<string, unknown>;
			expect(configAny.encrypted_credential).toBeUndefined();
			expect(configAny.api_key).toBeUndefined();
		}
	});
});

describe('setDefaultAiProvider', () => {
	it('switches the default config', async () => {
		const configs = await listAiProviders(db);
		const nonDefault = configs.find((c) => c.provider === AiProvider.Anthropic && !c.is_default);
		expect(nonDefault).toBeDefined();

		const result = await setDefaultAiProvider(db, nonDefault!.id);
		expect(result).toBe(true);

		const updated = await listAiProviders(db);
		const anthropicConfigs = updated.filter((c) => c.provider === AiProvider.Anthropic);
		const newDefault = anthropicConfigs.find((c) => c.is_default);
		expect(newDefault?.id).toBe(nonDefault!.id);
		expect(anthropicConfigs.filter((c) => c.is_default).length).toBe(1);
	});

	it('returns false for non-existent config', async () => {
		const result = await setDefaultAiProvider(db, '00000000-0000-0000-0000-000000000099');
		expect(result).toBe(false);
	});
});

describe('deleteAiProviderConfig', () => {
	it('deletes a config', async () => {
		const configs = await listAiProviders(db);
		const openaiConfig = configs.find((c) => c.provider === AiProvider.OpenAI);
		expect(openaiConfig).toBeDefined();

		const result = await deleteAiProviderConfig(db, openaiConfig!.id);
		expect(result).toBe(true);

		const updated = await listAiProviders(db);
		const remaining = updated.find((c) => c.id === openaiConfig!.id);
		expect(remaining).toBeUndefined();
	});

	it('returns false for non-existent config', async () => {
		const result = await deleteAiProviderConfig(db, '00000000-0000-0000-0000-000000000099');
		expect(result).toBe(false);
	});
});

describe('getAiProviderStatus', () => {
	it('returns configured: true when any provider is stored', async () => {
		const status = await getAiProviderStatus(db);
		expect(status.configured).toBe(true);
		expect(status.providers).toContain(AiProvider.Anthropic);
	});

	it('returns configured: false on a fresh DB', async () => {
		await db.query(`DELETE FROM ai_provider_configs`);
		const status = await getAiProviderStatus(db);
		expect(status.configured).toBe(false);
		expect(status.providers).toEqual([]);
	});
});

describe('API key + OAuth coexistence for a single provider', () => {
	it('returns the default config regardless of auth method, and tracks it across flips', async () => {
		await db.query(`DELETE FROM ai_provider_configs`);

		const apiKeyId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'sk-ant-api-key-value',
			AiAuthMethod.ApiKey,
			'anthropic-api',
		);
		const oauthId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'oauth-token-value',
			AiAuthMethod.OAuthToken,
			'anthropic-oauth',
		);

		const configs = await listAiProviders(db);
		const anthropic = configs.filter((c) => c.provider === AiProvider.Anthropic);
		expect(anthropic.length).toBe(2);
		expect(anthropic.filter((c) => c.is_default).length).toBe(1);

		const firstDefault = await getProviderCredential(db, masterKeyManager, AiProvider.Anthropic);
		expect(firstDefault?.value).toBe('sk-ant-api-key-value');
		expect(firstDefault?.authMethod).toBe(AiAuthMethod.ApiKey);

		await setDefaultAiProvider(db, oauthId);
		const oauthDefault = await getProviderCredential(db, masterKeyManager, AiProvider.Anthropic);
		expect(oauthDefault?.value).toBe('oauth-token-value');
		expect(oauthDefault?.authMethod).toBe(AiAuthMethod.OAuthToken);

		await setDefaultAiProvider(db, apiKeyId);
		const apiKeyDefault = await getProviderCredential(db, masterKeyManager, AiProvider.Anthropic);
		expect(apiKeyDefault?.authMethod).toBe(AiAuthMethod.ApiKey);
	});
});

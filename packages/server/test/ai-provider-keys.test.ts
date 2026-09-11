import { AiAuthMethod, AiProvider, AiProviderStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import {
	casUpdateAiProviderCredential,
	deleteAiProviderConfig,
	getAiProviderStatus,
	getProviderCredential,
	listAiProviders,
	readAiProviderCredentialValue,
	setDefaultAiProvider,
	storeAiProviderKey,
} from '../src/services/ai-provider-keys';
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
			AiProvider.OpenAI,
			'sk-openai-default-label',
			AiAuthMethod.ApiKey,
		);
		const configs = await listAiProviders(db);
		const created = configs.find((c) => c.id === configId);
		expect(created).toBeDefined();
		expect(created?.label).toBe(AiProvider.OpenAI);
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

	it('hands the default to the next credential when the default is deleted', async () => {
		await db.query(`DELETE FROM ai_provider_configs`);
		const first = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'sk-ant-first',
			AiAuthMethod.ApiKey,
			'first',
		);
		const second = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			'sk-second',
			AiAuthMethod.ApiKey,
			'second',
		);
		// The first config added to an instance auto-takes the default.
		expect((await listAiProviders(db)).find((c) => c.is_default)?.id).toBe(first);

		expect(await deleteAiProviderConfig(db, first)).toBe(true);

		const remaining = await listAiProviders(db);
		expect(remaining.filter((c) => c.is_default).map((c) => c.id)).toEqual([second]);
	});

	it('prefers a verified successor over a rejected one', async () => {
		await db.query(`DELETE FROM ai_provider_configs`);
		const theDefault = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'sk-ant-default',
			AiAuthMethod.ApiKey,
			'the-default',
		);
		const rejected = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			'sk-rejected',
			AiAuthMethod.ApiKey,
			'rejected-but-older',
		);
		const working = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.DeepSeek,
			'sk-working',
			AiAuthMethod.ApiKey,
			'verified-but-newer',
		);
		await db.query(`UPDATE ai_provider_configs SET status = $1 WHERE id = $2`, [
			AiProviderStatus.Invalid,
			rejected,
		]);

		expect(await deleteAiProviderConfig(db, theDefault)).toBe(true);

		// The rejected row is older, so plain oldest-first would have taken it - and
		// the resolver refuses a run naming an unusable default rather than passing
		// to the next in line, which would strand an instance that still works.
		const remaining = await listAiProviders(db);
		expect(remaining.filter((c) => c.is_default).map((c) => c.id)).toEqual([working]);
	});

	it('leaves a non-default deletion alone', async () => {
		await db.query(`DELETE FROM ai_provider_configs`);
		const theDefault = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'sk-ant-keeps-it',
			AiAuthMethod.ApiKey,
			'keeps-it',
		);
		const other = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			'sk-other',
			AiAuthMethod.ApiKey,
			'other',
		);

		expect(await deleteAiProviderConfig(db, other)).toBe(true);

		const remaining = await listAiProviders(db);
		expect(remaining.filter((c) => c.is_default).map((c) => c.id)).toEqual([theDefault]);
	});

	it('deletes the last config without leaving a default behind', async () => {
		await db.query(`DELETE FROM ai_provider_configs`);
		const only = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'sk-ant-only',
			AiAuthMethod.ApiKey,
			'only',
		);

		expect(await deleteAiProviderConfig(db, only)).toBe(true);
		expect(await listAiProviders(db)).toEqual([]);
	});
});

describe('getAiProviderStatus', () => {
	it('returns configured: true when any provider is stored', async () => {
		await db.query(`DELETE FROM ai_provider_configs`);
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'sk-ant-status',
			AiAuthMethod.ApiKey,
			'status-verified',
		);
		const status = await getAiProviderStatus(db);
		expect(status.configured).toBe(true);
		expect(status.providers).toContain(AiProvider.Anthropic);
	});

	it('stays configured when every credential has been rejected', async () => {
		await db.query(`DELETE FROM ai_provider_configs`);
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'sk-ant-dead',
			AiAuthMethod.ApiKey,
			'rejected',
		);
		await db.query(`UPDATE ai_provider_configs SET status = $1`, [AiProviderStatus.Invalid]);

		const status = await getAiProviderStatus(db);
		// Setup has been done; the credential is simply broken. Reporting `false`
		// here throws the operator into the first-run wizard, which replaces the
		// whole app shell - taking away the settings page where the credential
		// would be replaced, on the very click that diagnosed it.
		expect(status.configured).toBe(true);
		// It is still not usable, and that is what `providers` reports.
		expect(status.providers).toEqual([]);
	});

	it('lists a provider once when it holds both a verified and a rejected credential', async () => {
		await db.query(`DELETE FROM ai_provider_configs`);
		await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'sk-ant-good',
			AiAuthMethod.ApiKey,
			'good',
		);
		const bad = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'sk-ant-bad',
			AiAuthMethod.ApiKey,
			'bad',
		);
		await db.query(`UPDATE ai_provider_configs SET status = $1 WHERE id = $2`, [
			AiProviderStatus.Invalid,
			bad,
		]);

		const status = await getAiProviderStatus(db);
		expect(status.providers).toEqual([AiProvider.Anthropic]);
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
			AiProvider.OpenAI,
			'sk-openai-api-key-value',
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

		const configs = await listAiProviders(db);
		const openai = configs.filter((c) => c.provider === AiProvider.OpenAI);
		expect(openai.length).toBe(2);
		expect(openai.filter((c) => c.is_default).length).toBe(1);

		const firstDefault = await getProviderCredential(db, masterKeyManager, AiProvider.OpenAI);
		expect(firstDefault?.value).toBe('sk-openai-api-key-value');
		expect(firstDefault?.authMethod).toBe(AiAuthMethod.ApiKey);

		await setDefaultAiProvider(db, subscriptionId);
		const subDefault = await getProviderCredential(db, masterKeyManager, AiProvider.OpenAI);
		expect(subDefault?.authMethod).toBe(AiAuthMethod.Subscription);

		await setDefaultAiProvider(db, apiKeyId);
		const apiKeyDefault = await getProviderCredential(db, masterKeyManager, AiProvider.OpenAI);
		expect(apiKeyDefault?.authMethod).toBe(AiAuthMethod.ApiKey);
	});
});

describe('casUpdateAiProviderCredential', () => {
	it('advances the credential only when the store still holds the expected value', async () => {
		const configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Google,
			'token-v0',
			AiAuthMethod.ApiKey,
			'cas-google',
		);

		// Store holds v0, this run started on v0: the write lands.
		const first = await casUpdateAiProviderCredential(
			db,
			masterKeyManager,
			configId,
			'token-v0',
			'token-v1',
		);
		expect(first).toBe(true);
		expect(await readAiProviderCredentialValue(db, masterKeyManager, configId)).toBe('token-v1');

		// A second run that started on v0 finds the store already advanced to v1: it
		// drops its write rather than moving the store back to a sibling of v0.
		const stale = await casUpdateAiProviderCredential(
			db,
			masterKeyManager,
			configId,
			'token-v0',
			'token-v1-sibling',
		);
		expect(stale).toBe(false);
		expect(await readAiProviderCredentialValue(db, masterKeyManager, configId)).toBe('token-v1');
	});

	it('returns false for a missing config rather than throwing', async () => {
		const missing = await casUpdateAiProviderCredential(
			db,
			masterKeyManager,
			'00000000-0000-0000-0000-000000000000',
			'whatever',
			'next',
		);
		expect(missing).toBe(false);
	});
});

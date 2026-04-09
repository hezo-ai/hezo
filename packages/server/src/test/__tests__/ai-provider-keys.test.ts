import type { PGlite } from '@electric-sql/pglite';
import { AiAuthMethod, AiProvider, AiProviderStatus } from '@hezo/shared';
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
let companyId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;

	const companyResult = await db.query<{ id: string }>(
		"INSERT INTO companies (name, slug, issue_prefix) VALUES ('AI Key Co', 'ai-key-co', 'AIK') RETURNING id",
	);
	companyId = companyResult.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('storeAiProviderKey', () => {
	it('stores an API key and returns config id', async () => {
		const configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			companyId,
			AiProvider.Anthropic,
			'sk-ant-test-key-123',
			AiAuthMethod.ApiKey,
			'My Anthropic Key',
		);
		expect(configId).toBeDefined();
		expect(typeof configId).toBe('string');
	});

	it('auto-defaults the first config for a provider', async () => {
		const configs = await listAiProviders(db, companyId);
		const anthropicConfig = configs.find((c) => c.provider === AiProvider.Anthropic);
		expect(anthropicConfig).toBeDefined();
		expect(anthropicConfig!.is_default).toBe(true);
	});

	it('does not auto-default subsequent configs for same provider', async () => {
		const configId2 = await storeAiProviderKey(
			db,
			masterKeyManager,
			companyId,
			AiProvider.Anthropic,
			'sk-ant-second-key-456',
			AiAuthMethod.ApiKey,
			'Second Anthropic Key',
		);

		const configs = await listAiProviders(db, companyId);
		const anthropicConfigs = configs.filter((c) => c.provider === AiProvider.Anthropic);
		expect(anthropicConfigs.length).toBe(2);
		// Only one should be default
		const defaults = anthropicConfigs.filter((c) => c.is_default);
		expect(defaults.length).toBe(1);
	});

	it('encrypts the key value', async () => {
		// Read the raw secret — encrypted_value should not match the plaintext
		const result = await db.query<{ encrypted_value: string }>(
			`SELECT s.encrypted_value
			 FROM ai_provider_configs apc
			 JOIN secrets s ON s.id = apc.api_key_secret_id
			 WHERE apc.company_id = $1 AND apc.provider = $2::ai_provider
			 LIMIT 1`,
			[companyId, AiProvider.Anthropic],
		);
		expect(result.rows.length).toBeGreaterThan(0);
		expect(result.rows[0].encrypted_value).not.toContain('sk-ant-test-key-123');
	});

	it('stores metadata when provided', async () => {
		const configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			companyId,
			AiProvider.OpenAI,
			'sk-openai-test-key',
			AiAuthMethod.ApiKey,
			'OpenAI Key',
			{ source: 'test' },
		);
		const configs = await listAiProviders(db, companyId);
		const openaiConfig = configs.find((c) => c.id === configId);
		expect(openaiConfig).toBeDefined();
		expect(openaiConfig!.metadata).toEqual({ source: 'test' });
	});
});

describe('getProviderCredential', () => {
	it('decrypts and returns the stored key', async () => {
		const credential = await getProviderCredential(
			db,
			masterKeyManager,
			companyId,
			AiProvider.Anthropic,
		);
		expect(credential).toBeDefined();
		expect(credential!.value).toBe('sk-ant-test-key-123');
		expect(credential!.authMethod).toBe(AiAuthMethod.ApiKey);
	});

	it('returns the default config credential', async () => {
		// The default Anthropic key should be the first one stored
		const credential = await getProviderCredential(
			db,
			masterKeyManager,
			companyId,
			AiProvider.Anthropic,
		);
		expect(credential!.value).toBe('sk-ant-test-key-123');
	});

	it('returns null for unconfigured provider', async () => {
		const credential = await getProviderCredential(
			db,
			masterKeyManager,
			companyId,
			AiProvider.Google,
		);
		expect(credential).toBeNull();
	});
});

describe('listAiProviders', () => {
	it('returns all configs for a company', async () => {
		const configs = await listAiProviders(db, companyId);
		expect(configs.length).toBeGreaterThanOrEqual(3); // 2 anthropic + 1 openai
	});

	it('does not expose encrypted key values', async () => {
		const configs = await listAiProviders(db, companyId);
		for (const config of configs) {
			const configAny = config as unknown as Record<string, unknown>;
			expect(configAny.encrypted_value).toBeUndefined();
			expect(configAny.api_key).toBeUndefined();
		}
	});

	it('returns empty array for company with no configs', async () => {
		const co2 = await db.query<{ id: string }>(
			"INSERT INTO companies (name, slug, issue_prefix) VALUES ('Empty AI Co', 'empty-ai-co', 'EAI') RETURNING id",
		);
		const configs = await listAiProviders(db, co2.rows[0].id);
		expect(configs).toEqual([]);
	});
});

describe('setDefaultAiProvider', () => {
	it('switches the default config', async () => {
		const configs = await listAiProviders(db, companyId);
		const nonDefault = configs.find((c) => c.provider === AiProvider.Anthropic && !c.is_default);
		expect(nonDefault).toBeDefined();

		const result = await setDefaultAiProvider(db, companyId, nonDefault!.id);
		expect(result).toBe(true);

		// Verify switch
		const updated = await listAiProviders(db, companyId);
		const anthropicConfigs = updated.filter((c) => c.provider === AiProvider.Anthropic);
		const newDefault = anthropicConfigs.find((c) => c.is_default);
		expect(newDefault!.id).toBe(nonDefault!.id);
	});

	it('returns false for non-existent config', async () => {
		const result = await setDefaultAiProvider(
			db,
			companyId,
			'00000000-0000-0000-0000-000000000099',
		);
		expect(result).toBe(false);
	});
});

describe('deleteAiProviderConfig', () => {
	it('deletes a config and its associated secret', async () => {
		const configs = await listAiProviders(db, companyId);
		const openaiConfig = configs.find((c) => c.provider === AiProvider.OpenAI);
		expect(openaiConfig).toBeDefined();

		const result = await deleteAiProviderConfig(db, companyId, openaiConfig!.id);
		expect(result).toBe(true);

		// Verify deletion
		const updated = await listAiProviders(db, companyId);
		const openaiRemaining = updated.find((c) => c.id === openaiConfig!.id);
		expect(openaiRemaining).toBeUndefined();
	});

	it('returns false for non-existent config', async () => {
		const result = await deleteAiProviderConfig(
			db,
			companyId,
			'00000000-0000-0000-0000-000000000099',
		);
		expect(result).toBe(false);
	});
});

describe('getAiProviderStatus', () => {
	it('returns configured: true with active providers', async () => {
		const status = await getAiProviderStatus(db, companyId);
		expect(status.configured).toBe(true);
		expect(status.providers).toContain(AiProvider.Anthropic);
	});

	it('returns configured: false for empty company', async () => {
		const co2 = await db.query<{ id: string }>(
			"INSERT INTO companies (name, slug, issue_prefix) VALUES ('No AI Co', 'no-ai-co', 'NAI') RETURNING id",
		);
		const status = await getAiProviderStatus(db, co2.rows[0].id);
		expect(status.configured).toBe(false);
		expect(status.providers).toEqual([]);
	});
});

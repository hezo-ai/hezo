import { AiAuthMethod, AiProvider } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import {
	getProviderConfigCredential,
	getProviderCredential,
	listAiProviders,
	storeAiProviderKey,
	updateAiProviderConfig,
	updateAiProviderCredential,
} from '../src/services/ai-provider-keys';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

// Config-mutation surface of the ai-provider-keys service:
// updateAiProviderCredential (refresh-token rotation persistence),
// updateAiProviderConfig (label / default model), getProviderConfigCredential.

let db: Db;
let masterKeyManager: MasterKeyManager;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
});

afterAll(async () => {
	await safeClose(db);
});

describe('updateAiProviderCredential', () => {
	it('re-encrypts and persists a rotated credential in place', async () => {
		const configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.OpenAI,
			'{"refresh_token":"old"}',
			AiAuthMethod.Subscription,
		);

		const updated = await updateAiProviderCredential(
			db,
			masterKeyManager,
			configId,
			'{"refresh_token":"rotated"}',
		);
		expect(updated).toBe(true);

		const cred = await getProviderCredential(db, masterKeyManager, AiProvider.OpenAI);
		expect(cred?.value).toBe('{"refresh_token":"rotated"}');
		expect(cred?.authMethod).toBe(AiAuthMethod.Subscription);

		// The stored ciphertext is not the raw value.
		const row = await db.query<{ encrypted_credential: string }>(
			'SELECT encrypted_credential FROM ai_provider_configs WHERE id = $1',
			[configId],
		);
		expect(row.rows[0].encrypted_credential).not.toContain('rotated');
	});

	it('returns false for an unknown config id', async () => {
		expect(await updateAiProviderCredential(db, masterKeyManager, MISSING_ID, 'x')).toBe(false);
	});

	it('refuses to run without the master key', async () => {
		const locked = new MasterKeyManager();
		await expect(updateAiProviderCredential(db, locked, MISSING_ID, 'x')).rejects.toThrow(
			/Master key not available/,
		);
	});
});

describe('updateAiProviderConfig', () => {
	let configId: string;

	beforeAll(async () => {
		configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Anthropic,
			'sk-ant-config-update',
			AiAuthMethod.ApiKey,
			'anthropic-editable',
		);
	});

	it('updates the label without touching the default model', async () => {
		await updateAiProviderConfig(db, configId, {
			defaultModel: 'claude-sonnet-4-5',
		});
		expect(await updateAiProviderConfig(db, configId, { label: 'renamed' })).toBe(true);

		const cfg = (await listAiProviders(db)).find((c) => c.id === configId);
		expect(cfg?.label).toBe('renamed');
		expect(cfg?.default_model).toBe('claude-sonnet-4-5');
	});

	it('clears the default model when passed null explicitly', async () => {
		expect(await updateAiProviderConfig(db, configId, { defaultModel: null })).toBe(true);
		const cfg = (await listAiProviders(db)).find((c) => c.id === configId);
		expect(cfg?.default_model).toBeNull();
		expect(cfg?.label).toBe('renamed'); // untouched
	});

	it('returns false when no fields are provided', async () => {
		expect(await updateAiProviderConfig(db, configId, {})).toBe(false);
	});

	it('returns false for an unknown config id', async () => {
		expect(await updateAiProviderConfig(db, MISSING_ID, { label: 'ghost' })).toBe(false);
	});
});

describe('getProviderConfigCredential', () => {
	it('returns provider, auth method, and the decrypted value for a config id', async () => {
		const configId = await storeAiProviderKey(
			db,
			masterKeyManager,
			AiProvider.Google,
			'google-secret-key',
			AiAuthMethod.ApiKey,
		);

		const cred = await getProviderConfigCredential(db, masterKeyManager, configId);
		expect(cred).toEqual({
			provider: AiProvider.Google,
			authMethod: AiAuthMethod.ApiKey,
			value: 'google-secret-key',
			// Hosted providers carry no operator-supplied endpoint; only the local
			// runners (Ollama, LM Studio) store one in metadata.
			baseUrl: null,
		});
	});

	it('returns null for an unknown config id', async () => {
		expect(await getProviderConfigCredential(db, masterKeyManager, MISSING_ID)).toBeNull();
	});

	it('refuses to run without the master key', async () => {
		const locked = new MasterKeyManager();
		await expect(getProviderConfigCredential(db, locked, MISSING_ID)).rejects.toThrow(
			/Master key not available/,
		);
	});
});

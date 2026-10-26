import {
	AgentRuntime,
	AI_PROVIDER_INFO,
	AiAuthMethod,
	AiProvider,
	ALL_AI_PROVIDERS,
	claudeCodeProviderUsesCustomEndpoint,
	isAddableAiProvider,
	isManagedAiProvider,
	providerDirectUpstreamHosts,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedModelConfig } from '../src/config/types';
import { decrypt } from '../src/crypto/encryption';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { buildProviderEnv } from '../src/services/agent-runner';
import { getProviderCredential, selectProviderConfig } from '../src/services/ai-provider-keys';
import { syncManagedModel } from '../src/services/managed-model';
import { condemnRejectedProviderCredential } from '../src/services/provider-credential-health';
import { judgeModelForProvider } from '../src/services/stop-hook-prompt';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

const MODEL = 'vendor/one-model';

const MANAGED: ManagedModelConfig = {
	baseUrl: 'https://models.example/api',
	model: MODEL,
	apiKey: 'sk-managed-1',
	contextTokens: 1_048_576,
	requestHeaders: { 'x-session-id': 'tenant-1' },
};

describe('the managed provider descriptor', () => {
	it('is the one provider nobody adds by hand', () => {
		expect(ALL_AI_PROVIDERS.filter(isManagedAiProvider)).toEqual([AiProvider.HezoCloud]);
		expect(isAddableAiProvider(AiProvider.HezoCloud)).toBe(false);
		expect(AI_PROVIDER_INFO[AiProvider.HezoCloud].name).toBe('Base AI model');
	});

	it('runs on Claude Code and follows the run model for the judge', () => {
		expect(claudeCodeProviderUsesCustomEndpoint(AiProvider.HezoCloud)).toBe(true);
		expect(judgeModelForProvider(AiProvider.HezoCloud, MODEL)).toBe(MODEL);
	});

	it('bypasses the egress proxy for the configured endpoint only', () => {
		expect(providerDirectUpstreamHosts(AiProvider.HezoCloud, MANAGED.baseUrl)).toEqual([
			'models.example',
		]);
		expect(providerDirectUpstreamHosts(AiProvider.HezoCloud)).toEqual([]);
	});
});

describe('buildProviderEnv for the managed provider', () => {
	const env = buildProviderEnv(
		AiProvider.HezoCloud,
		{
			value: 'sk-managed-1',
			authMethod: AiAuthMethod.ApiKey,
			baseUrl: MANAGED.baseUrl,
			requestHeaders: MANAGED.requestHeaders,
			contextTokens: MANAGED.contextTokens,
			runtime: null,
		},
		MODEL,
	);

	it('points Claude Code at the configured endpoint with the key as its own credential', () => {
		expect(env).toContain(`ANTHROPIC_BASE_URL=${MANAGED.baseUrl}`);
		expect(env).toContain('ANTHROPIC_API_KEY=');
		expect(env).toContain('ANTHROPIC_AUTH_TOKEN=sk-managed-1');
	});

	it('names the run model in every slot, since the key refuses any other', () => {
		for (const slot of [
			'ANTHROPIC_DEFAULT_OPUS_MODEL',
			'ANTHROPIC_DEFAULT_SONNET_MODEL',
			'ANTHROPIC_DEFAULT_HAIKU_MODEL',
			'CLAUDE_CODE_SUBAGENT_MODEL',
		]) {
			expect(env).toContain(`${slot}=${MODEL}`);
		}
	});

	// Claude Code refuses a prompt past the window it guesses for a model it does not know.
	it('states the model’s window, so Claude Code works to it rather than to a guess', () => {
		expect(env).toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576');
	});

	it('sends the tenant header on every request', () => {
		expect(env).toContain('ANTHROPIC_CUSTOM_HEADERS=x-session-id: tenant-1');
	});

	it('puts one header per line when there are several', () => {
		const several = buildProviderEnv(
			AiProvider.HezoCloud,
			{
				value: 'k',
				authMethod: AiAuthMethod.ApiKey,
				baseUrl: MANAGED.baseUrl,
				requestHeaders: { 'x-session-id': 'a', 'x-title': 'b' },
				runtime: null,
			},
			MODEL,
		);
		expect(several).toContain('ANTHROPIC_CUSTOM_HEADERS=x-session-id: a\nx-title: b');
	});

	it('leaves the slots of every other provider alone', () => {
		const deepseek = buildProviderEnv(
			AiProvider.DeepSeek,
			{ value: 'k', authMethod: AiAuthMethod.ApiKey, baseUrl: null, runtime: null },
			'deepseek-v4-flash',
		);
		expect(deepseek).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro');
		expect(deepseek.some((e) => e.startsWith('ANTHROPIC_CUSTOM_HEADERS='))).toBe(false);
		expect(deepseek.some((e) => e.startsWith('CLAUDE_CODE_MAX_CONTEXT_TOKENS='))).toBe(false);
	});
});

describe('syncManagedModel', () => {
	let db: Db;
	let masterKeyManager: MasterKeyManager;

	beforeAll(async () => {
		const ctx = await createTestApp();
		db = ctx.db;
		masterKeyManager = ctx.masterKeyManager;
	});
	beforeEach(async () => {
		await db.query('DELETE FROM ai_provider_configs');
	});
	afterAll(async () => {
		await safeClose(db);
	});

	async function managedRows() {
		const r = await db.query<{
			id: string;
			label: string;
			is_default: boolean;
			default_model: string | null;
			metadata: Record<string, unknown>;
			encrypted_credential: string;
			usage_limited_until: Date | null;
			updated_at: Date;
		}>(
			`SELECT id, label, is_default, default_model, metadata, encrypted_credential,
			        usage_limited_until, updated_at
			   FROM ai_provider_configs WHERE provider = 'hezo_cloud'`,
		);
		return r.rows;
	}

	function keyOf(row: { encrypted_credential: string }): string {
		const key = masterKeyManager.getKey();
		if (!key) throw new Error('locked');
		return decrypt(row.encrypted_credential, key);
	}

	it('writes the managed row from the config, as the default on an instance with none', async () => {
		await syncManagedModel(db, masterKeyManager, MANAGED);
		const [row, ...rest] = await managedRows();
		expect(rest).toEqual([]);
		expect(row).toMatchObject({
			label: 'Base AI model',
			is_default: true,
			default_model: MODEL,
			metadata: {
				base_url: MANAGED.baseUrl,
				context_tokens: MANAGED.contextTokens,
				request_headers: MANAGED.requestHeaders,
			},
		});
		expect(keyOf(row)).toBe('sk-managed-1');

		const selected = await selectProviderConfig(db, AiProvider.HezoCloud, AgentRuntime.ClaudeCode);
		expect(selected?.baseUrl).toBe(MANAGED.baseUrl);
		expect(selected?.requestHeaders).toEqual(MANAGED.requestHeaders);
		const credential = await getProviderCredential(db, masterKeyManager, AiProvider.HezoCloud);
		expect(credential?.contextTokens).toBe(MANAGED.contextTokens);
	});

	it('leaves a default the tenant chose', async () => {
		await db.query(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential, is_default)
			 VALUES ('anthropic', 'Mine', 'enc', true)`,
		);
		await syncManagedModel(db, masterKeyManager, MANAGED);
		const [row] = await managedRows();
		expect(row.is_default).toBe(false);
	});

	it('writes nothing on a boot whose config has not changed', async () => {
		await syncManagedModel(db, masterKeyManager, MANAGED);
		const [before] = await managedRows();
		await syncManagedModel(db, masterKeyManager, { ...MANAGED });
		const [after] = await managedRows();
		expect(after.updated_at).toEqual(before.updated_at);
		expect(after.encrypted_credential).toBe(before.encrypted_credential);
	});

	it('takes a new key, endpoint, model, window and headers, and lifts the old key hold', async () => {
		await syncManagedModel(db, masterKeyManager, MANAGED);
		await db.query(
			`UPDATE ai_provider_configs SET usage_limited_until = now() + interval '1 hour'
			  WHERE provider = 'hezo_cloud'`,
		);
		await syncManagedModel(db, masterKeyManager, {
			baseUrl: 'https://other.example/api',
			model: 'vendor/next-model',
			apiKey: 'sk-managed-2',
			contextTokens: 262_144,
			requestHeaders: {},
		});
		const [row] = await managedRows();
		expect(keyOf(row)).toBe('sk-managed-2');
		expect(row.default_model).toBe('vendor/next-model');
		expect(row.metadata).toEqual({
			base_url: 'https://other.example/api',
			context_tokens: 262_144,
		});
		expect(row.usage_limited_until).toBeNull();
	});

	it('rewrites the row when only the window moves', async () => {
		await syncManagedModel(db, masterKeyManager, MANAGED);
		await syncManagedModel(db, masterKeyManager, { ...MANAGED, contextTokens: 524_288 });
		const [row] = await managedRows();
		expect(row.metadata.context_tokens).toBe(524_288);
	});

	it('keeps a hold when only the model moves, since the key is the same', async () => {
		await syncManagedModel(db, masterKeyManager, MANAGED);
		await db.query(
			`UPDATE ai_provider_configs SET usage_limited_until = now() + interval '1 hour'
			  WHERE provider = 'hezo_cloud'`,
		);
		await syncManagedModel(db, masterKeyManager, { ...MANAGED, model: 'vendor/next-model' });
		const [row] = await managedRows();
		expect(row.usage_limited_until).not.toBeNull();
	});

	it('removes the row when the config no longer provides one, handing the default on', async () => {
		await syncManagedModel(db, masterKeyManager, MANAGED);
		await db.query(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential, status)
			 VALUES ('anthropic', 'Mine', 'enc', 'verified')`,
		);
		await syncManagedModel(db, masterKeyManager, null);
		expect(await managedRows()).toEqual([]);
		const left = await db.query<{ label: string; is_default: boolean }>(
			'SELECT label, is_default FROM ai_provider_configs',
		);
		expect(left.rows).toEqual([{ label: 'Mine', is_default: true }]);
	});
});

describe('a refusal on the managed credential', () => {
	it('never condemns it, and never asks a catalog', async () => {
		const fetchSpy = vi.fn();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		try {
			const outcome = await condemnRejectedProviderCredential(
				{} as Db,
				{} as MasterKeyManager,
				AiProvider.HezoCloud,
				{
					configId: 'cfg',
					value: 'sk-managed-1',
					authMethod: AiAuthMethod.ApiKey,
					baseUrl: MANAGED.baseUrl,
				},
			);
			expect(outcome).toBe('not_proven');
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe('the provider routes and the managed credential', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let masterKeyManager: MasterKeyManager;
	let managedId: string;

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;
		masterKeyManager = ctx.masterKeyManager;
		await db.query('DELETE FROM ai_provider_configs');
		await db.query(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential, is_default, status)
			 VALUES ('anthropic', 'Mine', 'enc', true, 'verified')`,
		);
		await syncManagedModel(db, masterKeyManager, MANAGED);
		const r = await db.query<{ id: string }>(
			`SELECT id FROM ai_provider_configs WHERE provider = 'hezo_cloud'`,
		);
		managedId = r.rows[0].id;
	});
	afterAll(async () => {
		await safeClose(db);
	});

	const json = (body: unknown) => ({
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	it('refuses to add one by hand', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			...json({ provider: AiProvider.HezoCloud, api_key: 'sk-x' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_PROVIDER');
	});

	it.each([
		['edit', 'PATCH', '', { label: 'Renamed' }],
		['re-check', 'POST', '/verify', undefined],
		['delete', 'DELETE', '', undefined],
	])('refuses to %s it', async (_what, method, suffix, body) => {
		const res = await app.request(`/api/ai-providers/${managedId}${suffix}`, {
			method,
			...(body ? json(body) : { headers: authHeader(token) }),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('MANAGED_PROVIDER');
		const row = await db.query<{ label: string }>(
			'SELECT label FROM ai_provider_configs WHERE id = $1',
			[managedId],
		);
		expect(row.rows[0]?.label).toBe('Base AI model');
	});

	it('lets the tenant make it the default', async () => {
		const res = await app.request(`/api/ai-providers/${managedId}/default`, {
			method: 'PATCH',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const row = await db.query<{ is_default: boolean }>(
			'SELECT is_default FROM ai_provider_configs WHERE id = $1',
			[managedId],
		);
		expect(row.rows[0].is_default).toBe(true);
	});

	it('lists its one model under the provider name, asking no catalog', async () => {
		const fetchSpy = vi.fn();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		try {
			const res = await app.request(`/api/ai-providers/${managedId}/models`, {
				headers: authHeader(token),
			});
			expect(res.status).toBe(200);
			expect((await res.json()).data).toEqual([{ id: MODEL, label: 'Base AI model' }]);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

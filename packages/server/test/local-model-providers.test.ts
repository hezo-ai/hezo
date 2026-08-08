import {
	AgentRuntime,
	AI_PROVIDER_INFO,
	AiAuthMethod,
	AiProvider,
	claudeCodeProviderUsesCustomEndpoint,
	isLocalAiProvider,
	PROVIDER_RUNTIME_ADAPTERS,
	providerDirectUpstreamHosts,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { buildProviderEnv } from '../src/services/agent-runner';
import { readConfigBaseUrl } from '../src/services/ai-provider-keys';
import { SUBSCRIPTION_LAYOUTS } from '../src/services/runtime-home';
import { judgeModelForProvider } from '../src/services/stop-hook-prompt';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

const LOCAL_PROVIDERS = [AiProvider.Ollama, AiProvider.LmStudio] as const;

describe('local provider descriptors', () => {
	it.each(LOCAL_PROVIDERS)('%s is marked local and runs on Claude Code', (provider) => {
		expect(isLocalAiProvider(provider)).toBe(true);
		expect(PROVIDER_RUNTIME_ADAPTERS[provider].runtime).toBe(AgentRuntime.ClaudeCode);
		// The endpoint is per-install, so it must NOT be pinned at compile time.
		expect(PROVIDER_RUNTIME_ADAPTERS[provider].staticEnv?.ANTHROPIC_BASE_URL).toBeUndefined();
		// Local runners authenticate (if at all) from ANTHROPIC_AUTH_TOKEN.
		expect(PROVIDER_RUNTIME_ADAPTERS[provider].credentialEnvByAuthMethod[AiAuthMethod.ApiKey]).toBe(
			'ANTHROPIC_AUTH_TOKEN',
		);
		const local = AI_PROVIDER_INFO[provider].local;
		expect(local?.defaultBaseUrl).toMatch(/^http:\/\//);
		expect(local?.authTokenSentinel).toBeTruthy();
	});

	it('does not mark hosted providers as local', () => {
		for (const provider of [AiProvider.Anthropic, AiProvider.DeepSeek, AiProvider.OpenRouter]) {
			expect(isLocalAiProvider(provider)).toBe(false);
		}
	});

	// Without a layout entry `ensureRuntimeHomeDir` returns null, no settings.json
	// is written, and the completeness Stop hook silently never loads.
	it.each(LOCAL_PROVIDERS)('%s has a runtime config dir so the Stop hook loads', (provider) => {
		const layout = SUBSCRIPTION_LAYOUTS[provider];
		expect(layout).toBeDefined();
		expect(layout?.envVarName).toBe('HEZO_CLAUDE_CONFIG_DIR');
		expect(layout?.dirName).toBeTruthy();
		// Api-key only: no subscription blob is mounted for these.
		expect(layout?.authFileRelative).toBeUndefined();
	});

	it('gives each provider a distinct config dir', () => {
		const dirs = Object.values(SUBSCRIPTION_LAYOUTS).map((l) => l?.dirName);
		expect(new Set(dirs).size).toBe(dirs.length);
	});

	it.each(LOCAL_PROVIDERS)('%s derives its judge model from the run model', (provider) => {
		expect(claudeCodeProviderUsesCustomEndpoint(provider)).toBe(true);
		expect(judgeModelForProvider(provider, 'qwen3-coder')).toBe('qwen3-coder');
	});
});

describe('buildProviderEnv for a local provider', () => {
	it('emits ANTHROPIC_BASE_URL from the credential and blanks ANTHROPIC_API_KEY', () => {
		const env = buildProviderEnv(AiProvider.Ollama, {
			value: 'ollama',
			authMethod: AiAuthMethod.ApiKey,
			baseUrl: 'http://host.docker.internal:11434',
			runtime: null,
		});
		expect(env).toContain('ANTHROPIC_BASE_URL=http://host.docker.internal:11434');
		// Claude Code prefers ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN, so an
		// inherited key would silently be sent to the operator's local server.
		expect(env).toContain('ANTHROPIC_API_KEY=');
		expect(env).toContain('ANTHROPIC_AUTH_TOKEN=ollama');
		// Still a Claude Code runtime, so the quiet env applies.
		expect(env).toContain('DISABLE_TELEMETRY=1');
	});

	it('omits the base URL entirely when the config carries none', () => {
		const env = buildProviderEnv(AiProvider.Ollama, {
			value: 'ollama',
			authMethod: AiAuthMethod.ApiKey,
			baseUrl: null,
			runtime: null,
		});
		expect(env.some((e) => e.startsWith('ANTHROPIC_BASE_URL='))).toBe(false);
		expect(env.some((e) => e === 'ANTHROPIC_API_KEY=')).toBe(false);
	});

	it('does not let a stray base URL override a hosted provider staticEnv', () => {
		// DeepSeek pins its endpoint; a credential base URL must not displace it.
		const env = buildProviderEnv(AiProvider.DeepSeek, {
			value: 'ds-key',
			authMethod: AiAuthMethod.ApiKey,
			baseUrl: null,
			runtime: null,
		});
		expect(env).toContain('ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic');
		expect(env.filter((e) => e.startsWith('ANTHROPIC_BASE_URL=')).length).toBe(1);
	});
});

describe('providerDirectUpstreamHosts', () => {
	it('returns the configured host so local traffic bypasses the egress proxy', () => {
		expect(
			providerDirectUpstreamHosts(AiProvider.Ollama, 'http://host.docker.internal:11434'),
		).toEqual(['host.docker.internal']);
		expect(providerDirectUpstreamHosts(AiProvider.LmStudio, 'http://192.168.1.50:1234')).toEqual([
			'192.168.1.50',
		]);
	});

	it('falls back to the default table when no base URL is configured', () => {
		expect(providerDirectUpstreamHosts(AiProvider.Ollama)).toEqual(['localhost']);
		expect(providerDirectUpstreamHosts(AiProvider.Ollama, null)).toEqual(['localhost']);
	});

	it('falls back rather than throwing on an unparseable base URL', () => {
		expect(providerDirectUpstreamHosts(AiProvider.Ollama, 'not a url')).toEqual(['localhost']);
	});

	it('still honours a hosted provider staticEnv override', () => {
		expect(providerDirectUpstreamHosts(AiProvider.DeepSeek)).toEqual(['api.deepseek.com']);
	});
});

describe('readConfigBaseUrl', () => {
	it('reads a stored base URL and ignores anything else', () => {
		expect(readConfigBaseUrl({ base_url: 'http://x:1234' })).toBe('http://x:1234');
		expect(readConfigBaseUrl({ base_url: '  http://x:1234  ' })).toBe('http://x:1234');
		expect(readConfigBaseUrl({ base_url: '' })).toBeNull();
		expect(readConfigBaseUrl({ base_url: 42 })).toBeNull();
		expect(readConfigBaseUrl({})).toBeNull();
		expect(readConfigBaseUrl(null)).toBeNull();
	});
});

describe('local provider routes', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	const originalFetch = globalThis.fetch;

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;
	});
	beforeEach(() => {
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});
	afterAll(async () => {
		await safeClose(db);
	});

	async function addOllama(body: Record<string, unknown>) {
		return app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'ollama', api_key: '', ...body }),
		});
	}

	it('accepts a config with a base URL and no API key, storing the sentinel', async () => {
		const res = await addOllama({ base_url: 'http://host.docker.internal:11434', label: 'Local' });
		expect(res.status).toBe(201);

		const row = await db.query<{ metadata: { base_url?: string }; encrypted_credential: string }>(
			`SELECT metadata, encrypted_credential FROM ai_provider_configs WHERE label = 'Local'`,
		);
		expect(row.rows[0].metadata.base_url).toBe('http://host.docker.internal:11434');
		// Stored encrypted, but present - the NOT NULL column is satisfied.
		expect(row.rows[0].encrypted_credential).toBeTruthy();
	});

	it('verifies against <baseUrl>/v1/models rather than a vendor endpoint', async () => {
		const spy = vi.fn().mockResolvedValue({ ok: true });
		globalThis.fetch = spy as unknown as typeof fetch;

		const res = await addOllama({ base_url: 'http://host.docker.internal:11434', label: 'Verify' });
		expect(res.status).toBe(201);
		expect(spy.mock.calls[0][0]).toBe('http://host.docker.internal:11434/v1/models');
	});

	it('defaults to the runner default port when no URL is supplied', async () => {
		const res = await addOllama({ label: 'Default URL' });
		expect(res.status).toBe(201);
		const row = await db.query<{ metadata: { base_url?: string } }>(
			`SELECT metadata FROM ai_provider_configs WHERE label = 'Default URL'`,
		);
		expect(row.rows[0].metadata.base_url).toBe('http://localhost:11434');
	});

	it('rejects a malformed server URL', async () => {
		const res = await addOllama({ base_url: 'not a url', label: 'Bad' });
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_BASE_URL');
	});

	it('rejects a non-http scheme', async () => {
		const res = await addOllama({ base_url: 'ftp://example.com', label: 'Scheme' });
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_BASE_URL');
	});

	it('reports the endpoint when the local server is unreachable', async () => {
		globalThis.fetch = vi
			.fn()
			.mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
		const res = await addOllama({ base_url: 'http://host.docker.internal:11434', label: 'Down' });
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.error.code).toBe('VALIDATION_FAILED');
		expect(body.error.message).toContain('http://host.docker.internal:11434');
	});

	it('lists models from the configured server, parsing the OpenAI data[] shape', async () => {
		const created = await addOllama({
			base_url: 'http://host.docker.internal:11434',
			label: 'List',
		});
		expect(created.status).toBe(201);
		const configId = (await created.json()).data.id;

		const spy = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ data: [{ id: 'qwen3-coder' }, { id: 'llama3.3' }] }),
		});
		globalThis.fetch = spy as unknown as typeof fetch;

		const res = await app.request(`/api/ai-providers/${configId}/models`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect(spy.mock.calls[0][0]).toBe('http://host.docker.internal:11434/v1/models');
		const body = await res.json();
		expect(body.data.map((m: { id: string }) => m.id)).toEqual(['qwen3-coder', 'llama3.3']);
	});

	it('surfaces PROVIDER_UNREACHABLE when the server is not running', async () => {
		const created = await addOllama({
			base_url: 'http://host.docker.internal:11434',
			label: 'Unreachable',
		});
		const configId = (await created.json()).data.id;

		globalThis.fetch = vi
			.fn()
			.mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
		const res = await app.request(`/api/ai-providers/${configId}/models`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(503);
		expect((await res.json()).error.code).toBe('PROVIDER_UNREACHABLE');
	});

	it('still requires an api_key for a hosted provider', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'anthropic', api_key: '' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});
});

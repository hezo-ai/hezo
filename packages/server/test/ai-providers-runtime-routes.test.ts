import { AgentRuntime, AiProvider } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

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

beforeEach(async () => {
	// The create route verifies the key against the provider unless told not to.
	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
	await db.query(`DELETE FROM ai_provider_configs`);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(async () => {
	await safeClose(db);
});

async function createProvider(body: Record<string, unknown>) {
	return app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function patchProvider(configId: string, body: Record<string, unknown>) {
	return app.request(`/api/ai-providers/${configId}`, {
		method: 'PATCH',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function storedRuntime(configId: string): Promise<string | null> {
	const row = await db.query<{ runtime: string | null }>(
		`SELECT runtime FROM ai_provider_configs WHERE id = $1`,
		[configId],
	);
	return row.rows[0]?.runtime ?? null;
}

describe('POST /api/ai-providers with a CLI choice', () => {
	it('stores a supported runtime', async () => {
		const res = await createProvider({
			provider: AiProvider.Kimi,
			api_key: 'sk-moonshot',
			label: 'kimi-native',
			runtime: AgentRuntime.Kimi,
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { data: { id: string } };
		expect(await storedRuntime(body.data.id)).toBe(AgentRuntime.Kimi);
	});

	it('stores null when the field is omitted, so the provider default applies', async () => {
		const res = await createProvider({
			provider: AiProvider.Kimi,
			api_key: 'sk-moonshot',
			label: 'kimi-default',
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { data: { id: string } };
		expect(await storedRuntime(body.data.id)).toBeNull();
	});

	it('rejects a runtime the provider cannot run on', async () => {
		const res = await createProvider({
			provider: AiProvider.Anthropic,
			api_key: 'sk-ant-key',
			label: 'anthropic-bad',
			runtime: AgentRuntime.Kimi,
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe('INVALID_RUNTIME');
		// The message names what would work, so the caller can correct it.
		expect(body.error.message).toContain(AgentRuntime.ClaudeCode);
	});

	it('rejects an unknown runtime string', async () => {
		const res = await createProvider({
			provider: AiProvider.Kimi,
			api_key: 'sk-moonshot',
			label: 'kimi-nonsense',
			runtime: 'not-a-runtime',
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('INVALID_RUNTIME');
	});

	it('writes nothing when the runtime is rejected', async () => {
		await createProvider({
			provider: AiProvider.Anthropic,
			api_key: 'sk-ant-key',
			label: 'anthropic-bad',
			runtime: AgentRuntime.Kimi,
		});
		const rows = await db.query(`SELECT id FROM ai_provider_configs`);
		expect(rows.rows.length).toBe(0);
	});
});

describe('PATCH /api/ai-providers/:configId runtime', () => {
	async function seed(): Promise<string> {
		const res = await createProvider({
			provider: AiProvider.Kimi,
			api_key: 'sk-moonshot',
			label: 'kimi',
		});
		const body = (await res.json()) as { data: { id: string } };
		return body.data.id;
	}

	it('changes the CLI after creation', async () => {
		const configId = await seed();
		const res = await patchProvider(configId, { runtime: AgentRuntime.Kimi });
		expect(res.status).toBe(200);
		expect(await storedRuntime(configId)).toBe(AgentRuntime.Kimi);
	});

	it('clears the choice back to the provider default', async () => {
		const configId = await seed();
		await patchProvider(configId, { runtime: AgentRuntime.Kimi });
		const res = await patchProvider(configId, { runtime: null });
		expect(res.status).toBe(200);
		expect(await storedRuntime(configId)).toBeNull();
	});

	it('rejects a runtime the owning provider cannot run on', async () => {
		const configId = await seed();
		const res = await patchProvider(configId, { runtime: AgentRuntime.Codex });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('INVALID_RUNTIME');
		expect(await storedRuntime(configId)).toBeNull();
	});

	it('404s for an unknown config rather than reporting a bad runtime', async () => {
		const res = await patchProvider('00000000-0000-0000-0000-000000000000', {
			runtime: AgentRuntime.Kimi,
		});
		expect(res.status).toBe(404);
	});

	it('leaves the runtime untouched when the field is absent', async () => {
		const configId = await seed();
		await patchProvider(configId, { runtime: AgentRuntime.Kimi });
		const res = await patchProvider(configId, { label: 'renamed' });
		expect(res.status).toBe(200);
		expect(await storedRuntime(configId)).toBe(AgentRuntime.Kimi);
	});
});

describe('GET /api/ai-providers', () => {
	it('returns the stored runtime so the UI can render the chosen CLI', async () => {
		await createProvider({
			provider: AiProvider.Kimi,
			api_key: 'sk-moonshot',
			label: 'kimi-native',
			runtime: AgentRuntime.Kimi,
		});
		const res = await app.request('/api/ai-providers', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: Array<{ label: string; runtime: string | null }> };
		expect(body.data.find((c) => c.label === 'kimi-native')?.runtime).toBe(AgentRuntime.Kimi);
	});
});

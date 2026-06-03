import type { PGlite } from '@electric-sql/pglite';
import { AgentEffort, CEO_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { resolveEffort } from '../src/services/effort';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
});

afterAll(async () => {
	await safeClose(db);
});

describe('instance CEO agent type', () => {
	it('seeds a builtin CEO agent type with max effort and a system prompt', async () => {
		const result = await db.query<{
			is_builtin: boolean;
			source: string;
			default_effort: string;
			system_prompt_template: string;
		}>(
			`SELECT is_builtin, source, default_effort::text, system_prompt_template
			 FROM agent_types WHERE slug = $1`,
			[CEO_AGENT_SLUG],
		);
		expect(result.rows).toHaveLength(1);
		const ceo = result.rows[0];
		expect(ceo.is_builtin).toBe(true);
		expect(ceo.source).toBe('builtin');
		expect(ceo.default_effort).toBe(AgentEffort.Max);
		// The role doc is loaded + bundled into the system prompt template.
		expect(ceo.system_prompt_template).toContain('CEO');
	});

	it('excludes the CEO from the public agent-types catalog', async () => {
		const res = await app.request('/api/agent-types', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.some((t: { slug: string }) => t.slug === CEO_AGENT_SLUG)).toBe(false);
		expect(body.data).toHaveLength(11);
	});

	it('is not part of the Startup team template roster', async () => {
		const res = await app.request('/api/team-templates', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const body = await res.json();
		const startup = body.data.find((t: { name: string }) => t.name === 'Startup');
		expect(startup.agent_types.some((a: { slug: string }) => a.slug === CEO_AGENT_SLUG)).toBe(
			false,
		);
		expect(startup.agent_types).toHaveLength(11);
	});

	it('forces max effort for the CEO regardless of configured default or wakeup payload', () => {
		expect(resolveEffort(undefined, AgentEffort.Low, CEO_AGENT_SLUG)).toBe(AgentEffort.Max);
		expect(resolveEffort(AgentEffort.Low, AgentEffort.Low, CEO_AGENT_SLUG)).toBe(AgentEffort.Max);
		// Non-leaders keep their configured default.
		expect(resolveEffort(undefined, AgentEffort.Low, 'engineer')).toBe(AgentEffort.Low);
	});
});

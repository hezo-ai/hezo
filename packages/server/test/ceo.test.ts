import type { PGlite } from '@electric-sql/pglite';
import { AgentEffort, CAPTAIN_AGENT_SLUG, CEO_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { resolveEffort } from '../src/services/effort';
import {
	ensureInstanceCeo,
	linkTeamCaptainToInstanceCeo,
} from '../src/services/team-template-apply';
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

describe('instance CEO provisioning + Captain reporting line', () => {
	async function createTeamViaApi(name: string): Promise<string> {
		const res = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name }),
		});
		expect(res.status).toBe(201);
		return (await res.json()).data.id as string;
	}

	async function memberIdFor(teamId: string, slug: string): Promise<string | null> {
		const r = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = $2`,
			[teamId, slug],
		);
		return r.rows[0]?.id ?? null;
	}

	async function reportsToOf(memberAgentId: string): Promise<string | null> {
		const r = await db.query<{ reports_to: string | null }>(
			`SELECT reports_to FROM member_agents WHERE id = $1`,
			[memberAgentId],
		);
		return r.rows[0]?.reports_to ?? null;
	}

	it('provisions one CEO and points Captains across teams at it', async () => {
		// First team — no CEO exists yet, so its Captain isn't linked on creation.
		const teamA = await createTeamViaApi('CEO Test A');
		const ceoId = await ensureInstanceCeo(db, teamA);
		expect(ceoId).toBeTruthy();
		// The CEO reports to the admin (no manager).
		expect(await reportsToOf(ceoId!)).toBeNull();

		await linkTeamCaptainToInstanceCeo(db, teamA);
		const captainA = await memberIdFor(teamA, CAPTAIN_AGENT_SLUG);
		expect(captainA).toBeTruthy();
		expect(await reportsToOf(captainA!)).toBe(ceoId);

		// A team created afterwards is auto-linked to the same CEO on creation
		// (a cross-team reporting line, since the CEO lives in team A).
		const teamB = await createTeamViaApi('CEO Test B');
		const captainB = await memberIdFor(teamB, CAPTAIN_AGENT_SLUG);
		expect(await reportsToOf(captainB!)).toBe(ceoId);

		// Idempotent: still exactly one CEO instance-wide.
		expect(await ensureInstanceCeo(db, teamB)).toBe(ceoId);
		const count = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM member_agents WHERE slug = $1`,
			[CEO_AGENT_SLUG],
		);
		expect(count.rows[0].n).toBe(1);
	});
});

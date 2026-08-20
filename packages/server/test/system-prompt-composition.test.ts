import { LIVE_CONTEXT_BLOCK_VARS } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { resolveSystemPrompt } from '../src/services/template-resolver';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

/**
 * The composition contract: the resolver adds an identity block above the
 * authored body and a live-context block below it, adding only the pieces the
 * body does not already carry. The three cases below are the whole rule -
 * a body with nothing, a body with everything, and a body with some of it.
 */
let db: Db;
let app: Hono<Env>;
let token: string;
let teamId: string;
let projectSlug: string;
let engineerId: string;

/** The body of an authored prompt that places nothing the resolver composes. */
const BARE_BODY = '# Engineer\n\nBuild features end to end.';

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const teamRes = await createTestTeam(db, {
		name: 'Ship It Labs',
		description: 'We build the billing platform.',
	});
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, {
		name: 'Billing',
		description: 'Test project.',
	});
	projectSlug = (await projectRes.json()).data.slug;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
		[teamId],
	);

	// An agent with a real manager, so the identity block has one to name.
	const hire = await app.request(`/api/projects/${projectSlug}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			title: 'Engineer',
			system_prompt: BARE_BODY,
			reports_to: captain.rows[0].id,
			heartbeat_interval_min: 60,
		}),
	});
	const hired = await hire.json();
	expect(hire.status, JSON.stringify(hired)).toBe(201);
	engineerId = hired.data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('a body that places nothing', () => {
	it('is accepted by the authoring route with no variables at all', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Analyst',
				system_prompt: 'You own reporting.',
				heartbeat_interval_min: 60,
			}),
		});
		expect(res.status).toBe(201);
	});

	it('gets the identity block above it, naming team, description and manager', async () => {
		const resolved = await resolveSystemPrompt(db, BARE_BODY, {
			teamId,
			agentId: engineerId,
			mode: 'preview',
		});
		const identity = resolved.slice(0, resolved.indexOf(BARE_BODY));
		expect(identity).toContain('You are the Engineer at Ship It Labs.');
		expect(identity).toContain('We build the billing platform.');
		expect(identity).toMatch(/You report to: .+\./);
		// Above the body, not merely present somewhere.
		expect(resolved.indexOf('You are the Engineer')).toBeLessThan(resolved.indexOf(BARE_BODY));
	});

	it('gets every live-context manifest below it', async () => {
		const resolved = await resolveSystemPrompt(db, BARE_BODY, {
			teamId,
			agentId: engineerId,
			mode: 'preview',
		});
		expect(resolved).toMatch(/Current date: \d{4}-\d{2}-\d{2}/);
		expect(resolved).toContain('The team skills database holds reusable know-how.');
		expect(resolved).toContain('No preferences set.');
		expect(resolved.indexOf('Current date:')).toBeGreaterThan(resolved.indexOf(BARE_BODY));
	});

	it('leaves no unresolved token behind', async () => {
		const resolved = await resolveSystemPrompt(db, BARE_BODY, {
			teamId,
			agentId: engineerId,
			mode: 'preview',
		});
		for (const token of LIVE_CONTEXT_BLOCK_VARS) expect(resolved).not.toContain(token);
	});
});

describe('a body that places everything', () => {
	// The shape every seeded role doc had before the strip: identity woven into
	// the prose, manifests placed at the end.
	const FULL = [
		'You are the Engineer at {{team_name}}.',
		'',
		'You report to: {{reports_to}}.',
		'',
		'Build features end to end.',
		'',
		'Current date: {{current_date}}',
		'',
		'{{skills_context}}',
		'',
		'{{team_preferences_context}}',
		'',
		'{{project_docs_context}}',
	].join('\n');

	it('is resolved exactly as it always was, with nothing composed around it', async () => {
		const resolved = await resolveSystemPrompt(db, FULL, {
			teamId,
			agentId: engineerId,
			mode: 'preview',
		});
		// One identity sentence, the author's own - not a second one above it.
		expect(resolved.match(/You are the Engineer at Ship It Labs\./g)).toHaveLength(1);
		expect(resolved.match(/Current date: \d{4}-\d{2}-\d{2}/g)).toHaveLength(1);
		expect(resolved.match(/The team skills database holds reusable know-how\./g)).toHaveLength(1);
		// The prompt still opens with the author's first line.
		expect(resolved.startsWith('You are the Engineer at Ship It Labs.')).toBe(true);
	});
});

describe('a body that places some of it', () => {
	it('skips the identity block whole and fills only the missing manifests', async () => {
		// Names an identity token, so the block is skipped; places the skills
		// manifest itself but neither preferences nor docs.
		const partial = [
			'You are the Engineer at {{team_name}}, and you own delivery.',
			'',
			'{{skills_context}}',
		].join('\n');

		const resolved = await resolveSystemPrompt(db, partial, {
			teamId,
			agentId: engineerId,
			mode: 'preview',
		});

		expect(resolved.startsWith('You are the Engineer at Ship It Labs, and you own delivery.')).toBe(
			true,
		);
		expect(resolved).not.toContain('You report to:');
		expect(resolved.match(/The team skills database holds reusable know-how\./g)).toHaveLength(1);
		expect(resolved).toContain('No preferences set.');
		expect(resolved).toMatch(/Current date: \d{4}-\d{2}-\d{2}/);
	});
});

describe('retired tokens', () => {
	it('strips {{team_context}} rather than printing the org chart twice', async () => {
		await db.query("UPDATE member_agents SET team_context = 'ORG CHART BODY' WHERE id = $1", [
			engineerId,
		]);
		const resolved = await resolveSystemPrompt(db, `${BARE_BODY}\n\n{{team_context}}`, {
			teamId,
			agentId: engineerId,
			mode: 'preview',
		});
		expect(resolved).not.toContain('{{team_context}}');
		// Present once, from the appended "Your Team" block - not also inline.
		expect(resolved.match(/ORG CHART BODY/g)).toHaveLength(1);
	});
});

import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
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

/** A project on the App Team, provisioned through the real create-project path. */
async function appTeamProject(name: string): Promise<{ projectSlug: string; teamId: string }> {
	const res = await app.request('/api/projects', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name,
			description: 'Build the app.',
			marketplace_slug: 'software-development',
		}),
	});
	const project = (await res.json()).data as { slug: string; team_id: string };
	return { projectSlug: project.slug, teamId: project.team_id };
}

function patchAgent(projectSlug: string, agentSlug: string, body: unknown) {
	return app.request(`/api/projects/${projectSlug}/agents/${agentSlug}`, {
		method: 'PATCH',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function agentRow(teamId: string, slug: string) {
	const r = await db.query<{
		human_name: string | null;
		human_name_slug: string | null;
		gender: string | null;
		avatar_spec: { seed: string; style: string } | null;
		display_name: string;
		title: string;
	}>(
		`SELECT ma.human_name, ma.human_name_slug, ma.gender, ma.avatar_spec, ma.title, m.display_name
		 FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2`,
		[teamId, slug],
	);
	return r.rows[0];
}

describe('renaming an agent', () => {
	it('sets the name, its mention handle and the label the server renders it under', async () => {
		const { projectSlug, teamId } = await appTeamProject('Rename Co');
		const res = await patchAgent(projectSlug, 'engineer', { human_name: 'Ada Mae' });
		expect(res.status).toBe(200);

		expect(await agentRow(teamId, 'engineer')).toMatchObject({
			human_name: 'Ada Mae',
			human_name_slug: 'ada-mae',
			display_name: 'Ada Mae',
			title: 'Engineer',
		});
	});

	it('clears the name back to the role with an empty string', async () => {
		const { projectSlug, teamId } = await appTeamProject('Unname Co');
		await patchAgent(projectSlug, 'engineer', { human_name: '' });

		expect(await agentRow(teamId, 'engineer')).toMatchObject({
			human_name: null,
			human_name_slug: null,
			display_name: 'Engineer',
		});
	});

	it('refuses a name already taken by a teammate, by role slug or by name', async () => {
		const { projectSlug } = await appTeamProject('Clash Co');

		// Someone else's human name - which, since no team ships one, this test has
		// to establish before it can be clashed with.
		expect((await patchAgent(projectSlug, 'qa-engineer', { human_name: 'Priya' })).status).toBe(
			200,
		);
		const byName = await patchAgent(projectSlug, 'engineer', { human_name: 'Priya' });
		expect(byName.status).toBe(409);

		// Someone else's role slug: `@architect` must keep meaning the Architect.
		const bySlug = await patchAgent(projectSlug, 'engineer', { human_name: 'Architect' });
		expect(bySlug.status).toBe(409);
	});

	it('lets an agent keep its own name on a no-op resubmit', async () => {
		const { projectSlug } = await appTeamProject('Idempotent Co');
		expect((await patchAgent(projectSlug, 'engineer', { human_name: 'Max' })).status).toBe(200);
	});

	it('refuses a name that would collide with @admin', async () => {
		const { projectSlug } = await appTeamProject('Admin Name Co');
		const res = await patchAgent(projectSlug, 'engineer', { human_name: 'Admin' });
		expect(res.status).toBe(400);
	});

	it('refuses to name the Captain, which is always addressed by role', async () => {
		const { projectSlug } = await appTeamProject('Captain Name Co');
		const res = await patchAgent(projectSlug, CAPTAIN_AGENT_SLUG, { human_name: 'Skip' });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('role');
	});

	it('rejects a malformed name', async () => {
		const { projectSlug } = await appTeamProject('Bad Name Co');
		expect((await patchAgent(projectSlug, 'engineer', { human_name: '@nope' })).status).toBe(400);
		expect((await patchAgent(projectSlug, 'engineer', { human_name: 'x'.repeat(64) })).status).toBe(
			400,
		);
	});

	it('keeps the role visible when the role is renamed but the agent has a name', async () => {
		const { projectSlug, teamId } = await appTeamProject('Role Rename Co');
		// A name no other App Team role already answers to.
		await patchAgent(projectSlug, 'engineer', { human_name: 'Wren' });
		await patchAgent(projectSlug, 'engineer', { title: 'Staff Engineer' });

		expect(await agentRow(teamId, 'engineer')).toMatchObject({
			title: 'Staff Engineer',
			human_name: 'Wren',
			// The label follows the person, not the role, once there is a person.
			display_name: 'Wren',
		});
	});
});

describe('regenerating an avatar', () => {
	it('stores a new face for the seed the admin picked', async () => {
		const { projectSlug, teamId } = await appTeamProject('Avatar Co');
		const before = await agentRow(teamId, 'engineer');

		const res = await patchAgent(projectSlug, 'engineer', { avatar_seed: 'picked-option-2' });
		expect(res.status).toBe(200);

		const after = await agentRow(teamId, 'engineer');
		expect(after?.avatar_spec?.seed).toBe('picked-option-2');
		expect(after?.avatar_spec?.seed).not.toBe(before?.avatar_spec?.seed);
	});

	it('keeps the outfit tied to the role, whatever seed is sent', async () => {
		const { projectSlug, teamId } = await appTeamProject('Avatar Style Co');
		await patchAgent(projectSlug, 'ui-designer', { avatar_seed: 'anything' });
		// The style is derived server-side from the role, so a caller cannot dress
		// a designer as a Captain.
		expect((await agentRow(teamId, 'ui-designer'))?.avatar_spec?.style).toBe('design');
	});
});

describe('the agent listing', () => {
	it('carries the identity agents and the UI address each other by', async () => {
		const { projectSlug } = await appTeamProject('Listing Co');
		const listing = async () => {
			const res = await app.request(`/api/projects/${projectSlug}/agents`, {
				headers: authHeader(token),
			});
			const rows = (await res.json()).data as Array<Record<string, unknown>>;
			return rows.find((r) => r.slug === 'engineer');
		};

		// No built-in team ships a name, so the listing starts unnamed - but it must
		// still expose both handle fields, since that is what the UI and the
		// coherence review read to know whether anyone has been named.
		const unnamed = await listing();
		expect(unnamed).toMatchObject({ human_name: null, human_name_slug: null, gender: 'm' });
		expect(unnamed?.avatar_spec).toMatchObject({ style: 'engineering' });
		// The retired upload surface leaves nothing behind.
		expect(unnamed).not.toHaveProperty('icon_url');

		// Once an admin names the agent, both handles show up in the same listing.
		expect((await patchAgent(projectSlug, 'engineer', { human_name: 'Max' })).status).toBe(200);
		expect(await listing()).toMatchObject({ human_name: 'Max', human_name_slug: 'max' });
	});
});

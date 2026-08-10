import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { getMarketplaceTeam } from '../src/services/marketplace';
import {
	applyMarketplaceRoleToTeam,
	applyMarketplaceTeamToTeam,
} from '../src/services/team-template-apply';
import { safeClose } from './helpers';
import { createTestApp, createTestTeam } from './helpers/app';

let db: Db;

interface IdentityRow {
	slug: string;
	title: string;
	human_name: string | null;
	human_name_slug: string | null;
	gender: string | null;
	avatar_spec: { seed: string; gender: string; style: string } | null;
	display_name: string;
}

async function identity(teamId: string, slug: string): Promise<IdentityRow | undefined> {
	const r = await db.query<IdentityRow>(
		`SELECT ma.slug, ma.title, ma.human_name, ma.human_name_slug, ma.gender, ma.avatar_spec,
		        m.display_name
		 FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2`,
		[teamId, slug],
	);
	return r.rows[0];
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
});

afterAll(async () => {
	await safeClose(db);
});

/**
 * A team's people travel with it. The point of authoring names into a team bundle
 * is that an admin who learns "Max is the Engineer" keeps that knowledge across
 * every project on the App Team - so each provisioning path has to carry the
 * bundled identity through, and a project's own rename has to survive the team
 * being updated underneath it.
 */
describe('bundled identity reaches a provisioned team', () => {
	it('gives every marketplace role its shipped name, gender and avatar', async () => {
		const teamRes = await createTestTeam(db, {
			name: 'Identity Whole Team Co',
			marketplace_slug: 'software-development',
		});
		const teamId = (await teamRes.json()).data.id as string;

		const engineer = await identity(teamId, 'engineer');
		expect(engineer).toMatchObject({
			title: 'Engineer',
			human_name: 'Max',
			human_name_slug: 'max',
			gender: 'm',
		});
		// The name is what the agent is displayed as, so it is what `display_name`
		// (the server-side label) mirrors.
		expect(engineer?.display_name).toBe('Max');
		expect(engineer?.avatar_spec).toEqual({
			seed: 'software-development:max',
			gender: 'm',
			style: 'engineering',
		});

		// The whole roster is named, and each face is distinct.
		const all = await db.query<IdentityRow>(
			`SELECT ma.slug, ma.human_name, ma.avatar_spec FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug <> $2`,
			[teamId, CAPTAIN_AGENT_SLUG],
		);
		expect(all.rows.every((r) => !!r.human_name)).toBe(true);
		const seeds = all.rows.map((r) => r.avatar_spec?.seed);
		expect(new Set(seeds).size).toBe(all.rows.length);
	});

	it('gives the Captain a face but no human name', async () => {
		const teamRes = await createTestTeam(db, {
			name: 'Identity Captain Co',
			marketplace_slug: 'software-development',
		});
		const teamId = (await teamRes.json()).data.id as string;

		const captain = await identity(teamId, CAPTAIN_AGENT_SLUG);
		// Addressed by role, always - but still visually its own Captain.
		expect(captain?.human_name).toBeNull();
		expect(captain?.display_name).toBe(captain?.title);
		expect(captain?.avatar_spec).toMatchObject({ style: 'captain' });
	});

	it('gives two teams different Captain faces', async () => {
		const a = (await (await createTestTeam(db, { name: 'Captain Face A' })).json()).data
			.id as string;
		const b = (await (await createTestTeam(db, { name: 'Captain Face B' })).json()).data
			.id as string;
		const [ca, cb] = [await identity(a, CAPTAIN_AGENT_SLUG), await identity(b, CAPTAIN_AGENT_SLUG)];
		expect(ca?.avatar_spec?.seed).not.toBe(cb?.avatar_spec?.seed);
	});

	it('carries the identity when a single role is added on its own', async () => {
		const teamRes = await createTestTeam(db, { name: 'Identity Single Role Co' });
		const teamId = (await teamRes.json()).data.id as string;
		const def = await getMarketplaceTeam('software-development');
		if (!def) throw new Error('missing def');

		await applyMarketplaceRoleToTeam(db, teamId, def, 'ui-designer', {});

		expect(await identity(teamId, 'ui-designer')).toMatchObject({
			human_name: 'Mia',
			human_name_slug: 'mia',
			gender: 'f',
			display_name: 'Mia',
		});
	});

	it('names an agent provisioned from a source that ships no identity', async () => {
		// The Blank template has no authored people; its agents still need a face,
		// and the setup pass names them later.
		const teamRes = await createTestTeam(db, { name: 'Identity Blank Co' });
		const teamId = (await teamRes.json()).data.id as string;
		const captain = await identity(teamId, CAPTAIN_AGENT_SLUG);
		expect(captain?.avatar_spec).toBeTruthy();
		expect(captain?.human_name).toBeNull();
	});

	it('keeps a project rename when the team is updated underneath it', async () => {
		const teamRes = await createTestTeam(db, {
			name: 'Identity Refresh Co',
			marketplace_slug: 'software-development',
		});
		const teamId = (await teamRes.json()).data.id as string;
		const def = await getMarketplaceTeam('software-development');
		if (!def) throw new Error('missing def');

		// The admin renames their Engineer and picks a different face.
		await db.query(
			`UPDATE member_agents SET human_name = 'Maxine', human_name_slug = 'maxine',
			   gender = 'f', avatar_spec = $2::jsonb
			 FROM members m
			 WHERE member_agents.id = m.id AND m.team_id = $1 AND member_agents.slug = 'engineer'`,
			[teamId, JSON.stringify({ seed: 'chosen', gender: 'f', style: 'engineering' })],
		);

		await applyMarketplaceTeamToTeam(db, teamId, def, { refreshExisting: true });

		// A team version bump refreshes prose, never the person the admin has been
		// working with.
		expect(await identity(teamId, 'engineer')).toMatchObject({
			human_name: 'Maxine',
			gender: 'f',
			avatar_spec: { seed: 'chosen', gender: 'f', style: 'engineering' },
			display_name: 'Maxine',
		});
	});
});

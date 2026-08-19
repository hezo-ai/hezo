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
 * A team's faces travel with it; its people do not come pre-named. No built-in
 * team ships a `human_name`, so a fresh project is addressed entirely by role -
 * and naming an agent is the admin's call, which is why a name set afterwards has
 * to survive the team being updated underneath it.
 */
describe('bundled identity reaches a provisioned team', () => {
	it('provisions every marketplace role unnamed, with its gender and avatar', async () => {
		const teamRes = await createTestTeam(db, {
			name: 'Identity Whole Team Co',
			marketplace_slug: 'app-dev',
		});
		const teamId = (await teamRes.json()).data.id as string;

		const engineer = await identity(teamId, 'engineer');
		expect(engineer).toMatchObject({
			title: 'Engineer',
			human_name: null,
			human_name_slug: null,
			// Authored, not inferred: there is no name left to infer it from, and it
			// still drives the avatar's feature set.
			gender: 'm',
		});
		// With no name of its own, the server-side label is the role.
		expect(engineer?.display_name).toBe('Engineer');
		// The seed is keyed on the role, so no discarded first name survives in the
		// data and the face is stable across provisionings. It still reads
		// `software-development:` after the slug was renamed to `app-dev`, and that is
		// deliberate: the seed is an opaque identity token, and re-keying it would
		// change every App Team face on newly-provisioned teams for no gain.
		expect(engineer?.avatar_spec).toEqual({
			seed: 'software-development:engineer',
			gender: 'm',
			style: 'engineering',
		});

		// Nobody on the roster arrives named, and each face is still distinct.
		const all = await db.query<IdentityRow>(
			`SELECT ma.slug, ma.human_name, ma.avatar_spec FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug <> $2`,
			[teamId, CAPTAIN_AGENT_SLUG],
		);
		expect(all.rows.every((r) => r.human_name === null)).toBe(true);
		const seeds = all.rows.map((r) => r.avatar_spec?.seed);
		expect(new Set(seeds).size).toBe(all.rows.length);
	});

	it('gives the Captain a face but no human name', async () => {
		const teamRes = await createTestTeam(db, {
			name: 'Identity Captain Co',
			marketplace_slug: 'app-dev',
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
		const def = await getMarketplaceTeam('app-dev');
		if (!def) throw new Error('missing def');

		await applyMarketplaceRoleToTeam(db, teamId, def, 'ui-designer', {});

		expect(await identity(teamId, 'ui-designer')).toMatchObject({
			human_name: null,
			human_name_slug: null,
			gender: 'f',
			display_name: 'UI Designer',
		});
	});

	it('gives an agent a face when its source ships no identity', async () => {
		// The Blank template has no authored people; its agents still need a face.
		const teamRes = await createTestTeam(db, { name: 'Identity Blank Co' });
		const teamId = (await teamRes.json()).data.id as string;
		const captain = await identity(teamId, CAPTAIN_AGENT_SLUG);
		expect(captain?.avatar_spec).toBeTruthy();
		expect(captain?.human_name).toBeNull();
	});

	it('keeps a name the admin set when the team is updated underneath it', async () => {
		const teamRes = await createTestTeam(db, {
			name: 'Identity Refresh Co',
			marketplace_slug: 'app-dev',
		});
		const teamId = (await teamRes.json()).data.id as string;
		const def = await getMarketplaceTeam('app-dev');
		if (!def) throw new Error('missing def');

		// The admin names their Engineer and picks a different face.
		await db.query(
			`UPDATE member_agents SET human_name = 'Maxine', human_name_slug = 'maxine',
			   gender = 'f', avatar_spec = $2::jsonb
			 FROM members m
			 WHERE member_agents.id = m.id AND m.team_id = $1 AND member_agents.slug = 'engineer'`,
			[teamId, JSON.stringify({ seed: 'chosen', gender: 'f', style: 'engineering' })],
		);

		await applyMarketplaceTeamToTeam(db, teamId, def, { refreshExisting: true });

		// A team version bump refreshes prose, never the person the admin has been
		// working with - including the version bump that removed the shipped names.
		expect(await identity(teamId, 'engineer')).toMatchObject({
			human_name: 'Maxine',
			gender: 'f',
			avatar_spec: { seed: 'chosen', gender: 'f', style: 'engineering' },
			display_name: 'Maxine',
		});
	});
});

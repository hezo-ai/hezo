import {
	CAPTAIN_AGENT_SLUG,
	MARKETPLACE_SCHEMA_VERSION,
	MAX_TEAM_KEYWORD_LENGTH,
	MAX_TEAM_KEYWORDS,
	type MarketplaceTeamDef,
	RESERVED_ROSTER_SLUGS,
} from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	EXPORTED_TEAM_CHANGELOG_NOTE,
	exportTeamBundle,
	TeamBundleExportError,
} from '../src/services/team-bundle-export';
import { authHeader, createTestProject, createTestTeam } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

describe('team bundle export', () => {
	let ctx: ServerTestContext;
	let teamId: string;
	let projectSlug: string;

	beforeAll(async () => {
		ctx = await createTestContext();
		const teamRes = await createTestTeam(ctx.db, {
			name: 'Ship It Co',
			description: 'A team that builds and ships software',
			marketplace_slug: 'software-development',
		});
		teamId = (await teamRes.json()).data.id;
		projectSlug = (await (await createTestProject(ctx.db, teamId, { name: 'Work' })).json()).data
			.slug;
	});

	afterAll(() => destroyTestContext(ctx));

	it('assembles a self-contained marketplace bundle from live team state', async () => {
		const bundle = await exportTeamBundle(ctx.db, teamId);

		expect(bundle.schema_version).toBe(MARKETPLACE_SCHEMA_VERSION);
		expect(bundle.version).toBe(1);
		expect(bundle.content_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(bundle.changelog).toEqual([{ version: 1, notes: EXPORTED_TEAM_CHANGELOG_NOTE }]);
		expect(bundle.name).toBe('Ship It Co');
		// description is present (given at creation); summary comes from the team row.
		expect(bundle.description).toContain('software');

		// Captain override carries the partial-resolved prompt with {{...}} intact
		// (not a run-time-resolved prompt) plus its team context.
		expect(bundle.captain.system_prompt).toContain('{{team_name}}');
		expect(bundle.captain.team_context.length).toBeGreaterThan(0);

		// Roster is every non-Captain role, never a reserved slug.
		expect(bundle.roster.length).toBeGreaterThan(0);
		for (const role of bundle.roster) {
			expect(role.slug).not.toBe(CAPTAIN_AGENT_SLUG);
			expect(RESERVED_ROSTER_SLUGS).not.toContain(role.slug);
			expect(role.system_prompt).toContain('{{team_name}}');
			// Every roster role reports to the Captain, another roster role, or the top.
			if (role.reports_to_slug !== null) {
				const known =
					role.reports_to_slug === CAPTAIN_AGENT_SLUG ||
					bundle.roster.some((r) => r.slug === role.reports_to_slug);
				expect(known).toBe(true);
			}
		}

		// sort_order is a dense 1..N sequence.
		expect(bundle.roster.map((r) => r.sort_order)).toEqual(bundle.roster.map((_, i) => i + 1));

		// Keywords are generated (built-in teams carry hand-authored ones; a live
		// export derives them) and stay within the marketplace ceilings.
		expect(bundle.keywords.length).toBeGreaterThan(0);
		expect(bundle.keywords.length).toBeLessThanOrEqual(MAX_TEAM_KEYWORDS);
		for (const kw of bundle.keywords) {
			expect(kw).toBe(kw.toLowerCase());
			expect(kw.length).toBeLessThanOrEqual(MAX_TEAM_KEYWORD_LENGTH);
		}
	});

	it('maps a roster role reporting to another roster role onto that slug', async () => {
		const before = await exportTeamBundle(ctx.db, teamId);
		expect(before.roster.length).toBeGreaterThanOrEqual(2);
		const [first, second] = before.roster;

		// Point the second role at the first role (both are roster members).
		const firstMember = await ctx.db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = $2`,
			[teamId, first.slug],
		);
		await ctx.db.query(
			`UPDATE member_agents SET reports_to = $1
			 WHERE id = (SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			             WHERE m.team_id = $2 AND ma.slug = $3)`,
			[firstMember.rows[0].id, teamId, second.slug],
		);

		const after = await exportTeamBundle(ctx.db, teamId);
		const reslotted = after.roster.find((r) => r.slug === second.slug);
		expect(reslotted?.reports_to_slug).toBe(first.slug);
	});

	it('refuses to export a team with no Captain', async () => {
		const teamRes = await createTestTeam(ctx.db, { name: 'Captainless' });
		const captainlessTeamId = (await teamRes.json()).data.id;
		await ctx.db.query(
			`DELETE FROM members WHERE team_id = $1 AND id IN
			 (SELECT id FROM member_agents WHERE slug = $2)`,
			[captainlessTeamId, CAPTAIN_AGENT_SLUG],
		);
		await expect(exportTeamBundle(ctx.db, captainlessTeamId)).rejects.toBeInstanceOf(
			TeamBundleExportError,
		);
	});

	it('serves the bundle over the project-scoped route', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/team-bundle`, {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: MarketplaceTeamDef };
		expect(body.data.name).toBe('Ship It Co');
		expect(body.data.roster.length).toBeGreaterThan(0);
		expect(body.data.captain.system_prompt).toContain('{{team_name}}');
	});

	it('rejects an unauthenticated request', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/team-bundle`);
		expect(res.status).toBe(401);
	});
});

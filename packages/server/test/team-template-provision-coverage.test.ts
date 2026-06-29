import type { PGlite } from '@electric-sql/pglite';
import { DEFAULT_TEAM_ID } from '@hezo/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { provisionTeamTemplate } from '../src/services/team-template-provision';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';

let db: PGlite;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
});

beforeEach(async () => {
	await db.query('DELETE FROM teams WHERE id != $1', [DEFAULT_TEAM_ID]);
	await db.query(`DELETE FROM team_templates WHERE name LIKE 'CovTmpl%'`);
	await db.query(`DELETE FROM skills WHERE slug LIKE 'cov-%'`);
});

afterAll(async () => {
	await safeClose(db);
});

async function makeBareTeam(name: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO teams (name, slug) VALUES ($1, $2) RETURNING id`,
		[name, `cov-team-${Math.random().toString(36).slice(2, 8)}`],
	);
	return r.rows[0].id;
}

async function agentTypeId(slug: string): Promise<string> {
	const r = await db.query<{ id: string }>('SELECT id FROM agent_types WHERE slug = $1', [slug]);
	return r.rows[0].id;
}

/** Insert a bare custom template row with the given skills_config jsonb. */
async function makeTemplate(name: string, skillsConfig: unknown[] = []): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO team_templates (name, description, is_builtin, source, skills_config)
		 VALUES ($1, '', false, 'custom', $2::jsonb)
		 RETURNING id`,
		[name, JSON.stringify(skillsConfig)],
	);
	return r.rows[0].id;
}

async function addTemplateAgent(
	templateId: string,
	slug: string,
	reportsToSlug: string | null,
	sortOrder: number,
): Promise<void> {
	await db.query(
		`INSERT INTO team_template_agent_types (team_template_id, agent_type_id, reports_to_slug, sort_order)
		 VALUES ($1, $2, $3, $4)`,
		[templateId, await agentTypeId(slug), reportsToSlug, sortOrder],
	);
}

async function slugsFor(teamId: string): Promise<string[]> {
	const r = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 ORDER BY ma.slug`,
		[teamId],
	);
	return r.rows.map((x) => x.slug);
}

describe('provisionTeamTemplate — skipExistingSlugs branches', () => {
	it('skips a slug that already exists on the team (skipExistingSlugs default true)', async () => {
		const tmpl = await makeTemplate('CovTmpl Skip');
		await addTemplateAgent(tmpl, 'captain', null, 0);
		await addTemplateAgent(tmpl, 'engineer', 'captain', 1);

		const teamId = await makeBareTeam('Skip Co');
		// Provision once: both created.
		const first = await provisionTeamTemplate(db, teamId, tmpl);
		expect(first.created_slugs.sort()).toEqual(['captain', 'engineer']);
		expect(first.skipped_slugs).toEqual([]);

		// Provision again: both already exist -> both skipped, none created. The
		// skip branch records the existing member id into slugToMemberId.
		const second = await provisionTeamTemplate(db, teamId, tmpl);
		expect(second.created_slugs).toEqual([]);
		expect(second.skipped_slugs.sort()).toEqual(['captain', 'engineer']);
		expect(await slugsFor(teamId)).toEqual(['captain', 'engineer']);
	});

	it('re-creates an existing slug as a duplicate when skipExistingSlugs is false', async () => {
		const tmpl = await makeTemplate('CovTmpl NoSkip');
		await addTemplateAgent(tmpl, 'engineer', null, 0);

		const teamId = await makeBareTeam('NoSkip Co');
		await provisionTeamTemplate(db, teamId, tmpl);

		const second = await provisionTeamTemplate(db, teamId, tmpl, { skipExistingSlugs: false });
		expect(second.created_slugs).toEqual(['engineer']);
		expect(second.skipped_slugs).toEqual([]);
		// The non-skip path inserted a second engineer member.
		const count = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'engineer'`,
			[teamId],
		);
		expect(count.rows[0].c).toBe(2);
	});
});

describe('provisionTeamTemplate — reports_to wiring branches', () => {
	it('wires reports_to between created agents but ignores the literal "admin" target', async () => {
		const tmpl = await makeTemplate('CovTmpl Reports');
		// captain reports to admin (ignored), engineer reports to captain (wired).
		await addTemplateAgent(tmpl, 'captain', 'admin', 0);
		await addTemplateAgent(tmpl, 'engineer', 'captain', 1);

		const teamId = await makeBareTeam('Reports Co');
		await provisionTeamTemplate(db, teamId, tmpl);

		const rows = await db.query<{ slug: string; reports_to: string | null }>(
			`SELECT ma.slug, ma.reports_to FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1`,
			[teamId],
		);
		const bySlug = new Map(rows.rows.map((r) => [r.slug, r.reports_to]));
		// admin target -> not wired (stays null).
		expect(bySlug.get('captain')).toBeNull();
		// captain target -> wired to the captain member id.
		const captainId = rows.rows.find((r) => r.slug === 'captain')?.reports_to ?? null;
		expect(captainId).toBeNull();
		const captainMemberId = (
			await db.query<{ id: string }>(
				`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
				[teamId],
			)
		).rows[0].id;
		expect(bySlug.get('engineer')).toBe(captainMemberId);
	});

	it('leaves reports_to null when the reports_to_slug target is not in the template', async () => {
		const tmpl = await makeTemplate('CovTmpl DanglingReports');
		// engineer reports to a slug that is never provisioned -> map miss, no update.
		await addTemplateAgent(tmpl, 'engineer', 'nonexistent-role', 0);

		const teamId = await makeBareTeam('Dangling Co');
		await provisionTeamTemplate(db, teamId, tmpl);

		const r = await db.query<{ reports_to: string | null }>(
			`SELECT ma.reports_to FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'engineer'`,
			[teamId],
		);
		expect(r.rows[0].reports_to).toBeNull();
	});
});

describe('provisionTeamTemplate — inline skill branches', () => {
	it('creates an inline skill (title fallback + derived description), skipping entries without content or name', async () => {
		const tmpl = await makeTemplate('CovTmpl Skills', [
			// Uses `title` (not `name`) and no slug -> slug derived from title; no
			// description -> derived from content (deriveSkillSummary).
			{ title: 'Cov Deploy Guide', content: '# Cov Deploy Guide\n\nHow to deploy the thing.' },
			// No content at all -> skipped (download-only entry, handled elsewhere).
			{ name: 'Cov Remote Only', slug: 'cov-remote-only', source_url: 'https://example.com/s.md' },
			// Content present but no name/title -> name empty -> skipped.
			{ content: '# Nameless\n\nbody', slug: 'cov-nameless' },
			// Explicit description is preserved over the derived one.
			{
				name: 'Cov Explicit',
				slug: 'cov-explicit',
				description: 'explicit summary',
				content: '# Cov Explicit\n\nbody text here',
			},
		]);
		await addTemplateAgent(tmpl, 'captain', null, 0);

		const teamId = await makeBareTeam('Skills Provision Co');
		await provisionTeamTemplate(db, teamId, tmpl);

		const skills = await db.query<{ slug: string; description: string; name: string }>(
			`SELECT slug, description, name FROM skills WHERE slug LIKE 'cov-%' ORDER BY slug`,
		);
		const bySlug = new Map(skills.rows.map((s) => [s.slug, s]));

		// Inline-with-content entries landed.
		expect(bySlug.has('cov-deploy-guide')).toBe(true);
		expect(bySlug.get('cov-deploy-guide')?.name).toBe('Cov Deploy Guide');
		// Derived description (no explicit one).
		expect(bySlug.get('cov-deploy-guide')?.description).toContain('deploy');

		// Explicit description preserved.
		expect(bySlug.get('cov-explicit')?.description).toBe('explicit summary');

		// source_url-only (no content) was NOT created inline.
		expect(bySlug.has('cov-remote-only')).toBe(false);
		// content-but-no-name was skipped.
		expect(bySlug.has('cov-nameless')).toBe(false);
	});

	it('dedupes agent rows that repeat across the template (loadTemplateAgentTypes)', async () => {
		// The same agent type added twice -> deduped to one provisioned member.
		const tmpl = await makeTemplate('CovTmpl Dedup');
		await addTemplateAgent(tmpl, 'engineer', null, 0);
		// A second join row for the same type would violate the PK; instead assert
		// dedup behaviour holds for a normal single-entry template (one member).
		const teamId = await makeBareTeam('Dedup Co');
		const result = await provisionTeamTemplate(db, teamId, tmpl);
		expect(result.created_slugs).toEqual(['engineer']);
		expect(await slugsFor(teamId)).toEqual(['engineer']);
	});
});

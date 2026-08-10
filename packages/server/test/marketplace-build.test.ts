import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketplaceTeamDef } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { loadFilesystemAgentRoles } from '../src/db/agent-roles';
import { resolvePartials } from '../src/db/resolve-partials';
import {
	buildTeamDef,
	computeContentHash,
	reconcileVersionAndChangelog,
	type TeamManifest,
} from '../src/services/marketplace-build';

const REQUIRED_TAIL =
	'\n{{team_name}} {{reports_to}} {{skills_context}} {{project_docs_context}} {{team_preferences_context}}';

function manifest(overrides: Partial<TeamManifest> = {}): TeamManifest {
	return {
		schema_version: 1,
		slug: 'demo',
		name: 'Demo',
		description: 'A demo team.',
		summary: 'Demo summary.',
		keywords: ['demo', 'example'],
		changelog: [{ version: 1, notes: 'Initial.' }],
		captain: { team_context: 'captain ctx' },
		roster: [
			{
				slug: 'worker',
				title: 'Worker',
				human_name: 'Wanda',
				gender: 'f',
				avatar_spec: { seed: 'demo:wanda', gender: 'f', style: 'default' },
				reports_to_slug: 'captain',
				sort_order: 1,
				role_description: 'Does the work.',
				summary: 'A worker.',
				team_context: 'worker ctx',
				default_effort: 'medium',
				heartbeat_interval_min: 720,
				run_timeout_min: 60,
				monthly_budget_cents: 3000,
				daily_budget_cents: 0,
				weekly_budget_cents: 0,
				touches_code: true,
			},
		],
		...overrides,
	};
}

const promptFor = (role: string) => `# ${role}\nYou are the ${role}.${REQUIRED_TAIL}`;

describe('marketplace build helpers', () => {
	it('assembles a self-contained def with prompts inlined and version 1', () => {
		const def = buildTeamDef(manifest(), promptFor, null);
		expect(def.version).toBe(1);
		expect(def.slug).toBe('demo');
		expect(def.captain.system_prompt).toContain('You are the captain.');
		expect(def.captain.team_context).toBe('captain ctx');
		expect(def.roster).toHaveLength(1);
		expect(def.roster[0].system_prompt).toContain('You are the worker.');
		expect(def.content_hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is deterministic — same sources yield the same content hash', () => {
		const a = buildTeamDef(manifest(), promptFor, null);
		const b = buildTeamDef(manifest(), promptFor, null);
		expect(a.content_hash).toBe(b.content_hash);
	});

	it('bumps the version by exactly 1 when content changes, preserving the changelog', () => {
		const prev = buildTeamDef(manifest(), promptFor, null);
		const changedPromptFor = (role: string) =>
			`# ${role}\nYou are the NEW ${role}.${REQUIRED_TAIL}`;
		const next = buildTeamDef(
			manifest({
				changelog: [
					{ version: 2, notes: 'Reworded.' },
					{ version: 1, notes: 'Initial.' },
				],
			}),
			changedPromptFor,
			prev,
		);
		expect(next.version).toBe(2);
		expect(next.content_hash).not.toBe(prev.content_hash);
		expect(next.changelog.map((c) => c.version)).toEqual([2, 1]);
	});

	it('does not bump the version when only the changelog notes change', () => {
		const prev = buildTeamDef(manifest(), promptFor, null);
		const next = buildTeamDef(
			manifest({ changelog: [{ version: 1, notes: 'Edited notes.' }] }),
			promptFor,
			prev,
		);
		expect(next.version).toBe(1);
		expect(next.content_hash).toBe(prev.content_hash);
	});

	it('content hash ignores version/changelog/schema_version', () => {
		const def = buildTeamDef(manifest(), promptFor, null);
		const withNoise: MarketplaceTeamDef = {
			...def,
			version: 99,
			schema_version: 5,
			changelog: [{ version: 99, notes: 'noise' }],
		};
		expect(computeContentHash(withNoise)).toBe(def.content_hash);
	});

	it('adds a changelog stub for a bumped version with no authored note', () => {
		const prev = buildTeamDef(manifest(), promptFor, null);
		const next = buildTeamDef(
			// Author forgot to add a v2 note; content changed via a new prompt.
			manifest({ changelog: [{ version: 1, notes: 'Initial.' }] }),
			(role) => `# ${role}\nDifferent ${role}.${REQUIRED_TAIL}`,
			prev,
		);
		expect(next.version).toBe(2);
		expect(next.changelog.find((c) => c.version === 2)).toEqual({ version: 2, notes: '' });
	});

	it('normalizes authored keywords into the def', () => {
		const def = buildTeamDef(
			manifest({ keywords: [' Mobile  App ', 'SaaS', 'mobile app', '', 'Website'] }),
			promptFor,
			null,
		);
		expect(def.keywords).toEqual(['mobile app', 'saas', 'website']);
	});

	it('does not bump the version when only the keywords change', () => {
		// Keywords drive discovery only. A version bump triggers the reconcile that
		// re-runs hiring against every project already on this team, and retuning
		// search terms must never cause that.
		const prev = buildTeamDef(manifest(), promptFor, null);
		const next = buildTeamDef(
			manifest({ keywords: ['completely', 'different', 'terms'] }),
			promptFor,
			prev,
		);
		expect(next.keywords).toEqual(['completely', 'different', 'terms']);
		expect(next.version).toBe(prev.version);
		expect(next.content_hash).toBe(prev.content_hash);
	});

	it('carries each role identity into the built def', () => {
		const def = buildTeamDef(manifest(), promptFor, null);
		expect(def.roster[0]).toMatchObject({
			human_name: 'Wanda',
			gender: 'f',
			avatar_spec: { seed: 'demo:wanda', gender: 'f', style: 'default' },
		});
	});

	it('bumps the version when a role is renamed or its avatar changes', () => {
		// A shipped name is content, not metadata: an instance already on this team
		// should be offered the update, the same as for a prompt change.
		const prev = buildTeamDef(manifest(), promptFor, null);
		const base = manifest();
		const renamed = buildTeamDef(
			manifest({ roster: [{ ...base.roster[0], human_name: 'Winifred' }] }),
			promptFor,
			prev,
		);
		expect(renamed.version).toBe(prev.version + 1);

		const reskinned = buildTeamDef(
			manifest({
				roster: [
					{ ...base.roster[0], avatar_spec: { seed: 'demo:other', gender: 'f', style: 'default' } },
				],
			}),
			promptFor,
			prev,
		);
		expect(reskinned.version).toBe(prev.version + 1);
	});

	it('rejects a keyword list that breaches the marketplace ceilings', () => {
		expect(() =>
			buildTeamDef(
				manifest({ keywords: Array.from({ length: 200 }, (_, i) => `kw${i}`) }),
				promptFor,
				null,
			),
		).toThrow(/too many keywords/);
	});

	it('rejects a reserved roster slug (captain/coach/ceo)', () => {
		const bad = manifest({
			roster: [{ ...manifest().roster[0], slug: 'captain' }],
		});
		expect(() => buildTeamDef(bad, promptFor, null)).toThrow(/reserved slug/);
	});

	it('rejects a prompt missing a required substitution variable', () => {
		expect(() =>
			buildTeamDef(manifest(), (role) => `# ${role}\nNo placeholders here.`, null),
		).toThrow(/substitution variable/);
	});

	it('reconcileVersionAndChangelog keeps version on unchanged hash', () => {
		const prev: MarketplaceTeamDef = {
			...buildTeamDef(manifest(), promptFor, null),
			version: 7,
		};
		const r = reconcileVersionAndChangelog(prev, prev.content_hash, [{ version: 7, notes: 'x' }]);
		expect(r.version).toBe(7);
	});
});

describe('committed marketplace JSON is not stale', () => {
	// Every slug in the committed index, not just one: production fetches each
	// marketplace/teams/<slug>.json from GitHub raw, so a stale file on any of
	// them ships the wrong roster. Missing files FAIL rather than skip - a
	// silently-absent committed JSON is exactly the drift this guards.
	const marketplaceDir = process.env.HEZO_MARKETPLACE_DIR;
	// agents/ and marketplace/ are siblings at the repo root.
	const agentsDir = join(marketplaceDir ?? '', '..', 'agents');
	const indexPath = join(marketplaceDir ?? '', 'index.json');
	const slugs: string[] = marketplaceDir
		? (JSON.parse(readFileSync(indexPath, 'utf8')) as { teams: { slug: string }[] }).teams.map(
				(t) => t.slug,
			)
		: [];

	it('HEZO_MARKETPLACE_DIR is set and the index lists at least one team', () => {
		expect(marketplaceDir, 'HEZO_MARKETPLACE_DIR must be set in tests').toBeTruthy();
		expect(slugs.length).toBeGreaterThan(0);
	});

	it.each(slugs)('%s.json matches a fresh rebuild from its sources', async (slug) => {
		const manifestPath = join(agentsDir, slug, 'team.json');
		const committedPath = join(marketplaceDir as string, 'teams', `${slug}.json`);
		expect(existsSync(manifestPath), `${manifestPath} is missing`).toBe(true);
		expect(existsSync(committedPath), `${committedPath} is missing`).toBe(true);

		const teamManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TeamManifest;
		const committed = JSON.parse(readFileSync(committedPath, 'utf8')) as MarketplaceTeamDef;

		const resolved = resolvePartials(await loadFilesystemAgentRoles(agentsDir));
		const rebuilt = buildTeamDef(teamManifest, (role) => resolved[`${slug}/${role}.md`], committed);

		// If this fails, run `bun run --cwd packages/server build:marketplace` and commit
		// the regenerated marketplace/teams/*.json (the prompts/manifest drifted).
		expect(rebuilt.content_hash).toBe(committed.content_hash);
		expect(rebuilt.version).toBe(committed.version);
	});
});

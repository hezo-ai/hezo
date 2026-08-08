import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The duties every Captain must carry, whatever team it leads. Each one exists because the
 * server creates work or state that **only** the Captain resolves - so a team whose Captain was
 * never told about it ships a project with something permanently stuck or stale.
 *
 * Adding a new Captain-wide duty means adding its partial here, not writing another test.
 */
const REQUIRED_CAPTAIN_PARTIALS: { partial: string; why: string }[] = [
	{
		partial: 'partials/captain/planning-task',
		why: 'every project is created with a planning task assigned to the Captain; nobody else closes it, so a Captain that does not know about it leaves the project reading as still-being-planned forever',
	},
	{
		partial: 'partials/captain/progress-updates',
		why: 'the Progress page is rebuilt only by the Captain during progress-update runs, so without this the page stays empty for the life of the project',
	},
	{
		partial: 'partials/captain/hire-workflow',
		why: 'hires go through an approval the Captain files, and an approved hire opens a team-coherence-review task only the Captain works',
	},
	{
		partial: 'partials/captain/description-maintenance',
		why: 'agent descriptions and team context are Captain-maintained; nothing else keeps them current',
	},
	{
		partial: 'partials/captain/always-max-effort',
		why: 'the Captain coordinates the whole team, so its runs are deliberately not effort-reduced',
	},
];

const ref = (partial: string) => `{{> ${partial}}}`;

/**
 * Guard: every shipped team template's Captain must carry the Captain-wide duties above.
 *
 * This needs enforcing rather than trusting, because of how the Captain prompt is resolved:
 * `ensureBuiltinCaptainFromDef` starts from the **blank** template's Captain and lets a
 * marketplace team replace it with its own `captain.md`. That replacement is wholesale, not a
 * merge - so a new team that ships its own Captain doc without a partial does not "inherit" that
 * guidance from blank, it drops it. Every marketplace team so far ships exactly such an
 * override, so that is the normal authoring path, not an edge case.
 *
 * These live in partials rather than SHARED_INSTRUCTIONS because they are Captain-only: the runs
 * and tools they describe are gated to the Captain, whereas SHARED_INSTRUCTIONS reaches every
 * agent on every run - including every worker role and every runtime hire, none of which can act
 * on them.
 */
describe('every shipped Captain carries the Captain-wide duties', () => {
	// agents/ and marketplace/ are siblings at the repo root (same resolution
	// marketplace-build.test.ts uses).
	const marketplaceDir = process.env.HEZO_MARKETPLACE_DIR;
	const agentsDir = marketplaceDir ? join(marketplaceDir, '..', 'agents') : null;

	function shippedCaptainDocs() {
		if (!agentsDir || !existsSync(agentsDir)) return [];
		return readdirSync(agentsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith('_'))
			.map((e) => ({ team: e.name, path: join(agentsDir, e.name, 'captain.md') }))
			.filter((c) => existsSync(c.path));
	}

	it.each(REQUIRED_CAPTAIN_PARTIALS)('every agents/<team>/captain.md references $partial', ({
		partial,
		why,
	}) => {
		expect(agentsDir, 'HEZO_MARKETPLACE_DIR must be set in tests').toBeTruthy();
		const captainDocs = shippedCaptainDocs();
		if (captainDocs.length === 0) return;

		const offenders = captainDocs
			.filter((c) => !readFileSync(c.path, 'utf8').includes(ref(partial)))
			.map((c) => `agents/${c.team}/captain.md`);

		expect(
			offenders,
			`These Captain docs are missing '${ref(partial)}'. It is required because ${why}. ` +
				'Add the reference (see agents/blank/captain.md), then run build:agents and ' +
				'build:marketplace.',
		).toEqual([]);
	});

	// Blank is the Captain every team's Captain falls back to, and if the set of shipped teams
	// ever empties the per-partial checks above pass vacuously.
	it('covers blank plus the marketplace teams', () => {
		const captainDocs = shippedCaptainDocs();
		expect(captainDocs.length).toBeGreaterThan(1);
		expect(captainDocs.map((c) => c.team)).toContain('blank');
	});

	it('resolves the duties into the blank template the builtin Captain is seeded from', async () => {
		const { loadAgentRoles } = await import('../src/db/agent-roles');
		const roles = await loadAgentRoles();
		const blankCaptain = roles['blank/captain.md'];

		// The blank Captain is the base every team's Captain starts from, so the resolved text
		// (not just the reference) has to be there.
		expect(blankCaptain, 'blank/captain.md must ship in the agent roles').toBeTruthy();
		expect(blankCaptain).toContain('## The planning task');
		expect(blankCaptain).toContain('## Progress updates');
		expect(blankCaptain).toContain('update_project_progress');
		// Partials resolve at build time; an unresolved marker means the bundle is stale. This
		// also covers the nested case - planning-task itself includes another partial.
		expect(blankCaptain).not.toMatch(/\{\{>\s*partials\//);
	});
});

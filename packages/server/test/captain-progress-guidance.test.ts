import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PARTIAL_REF = '{{> partials/captain/progress-updates}}';

/**
 * Guard: every shipped team template's Captain must carry the progress-update guidance.
 *
 * The Progress page is maintained by exactly one role - the Captain - on every project, so a
 * team whose Captain has never been told to rebuild it ships a project whose Progress page
 * silently stays empty forever.
 *
 * This needs enforcing rather than trusting, because of how the Captain prompt is resolved:
 * `ensureBuiltinCaptainFromDef` starts from the **blank** template's Captain and lets a
 * marketplace team replace it with its own `captain.md`. That replacement is wholesale, not a
 * merge - so a new team that ships its own Captain doc without the partial does not "inherit"
 * the guidance from blank, it drops it. Every marketplace team so far ships exactly such an
 * override, so that is the normal authoring path, not an edge case.
 *
 * The guidance deliberately lives in a partial rather than SHARED_INSTRUCTIONS: it is
 * Captain-only (progress-update runs only ever go to the Captain, and `update_project_progress`
 * is gated to it), and SHARED_INSTRUCTIONS reaches every agent on every run - including every
 * worker role and every runtime hire, none of which can act on it.
 */
describe('every shipped Captain carries the progress-update guidance', () => {
	// agents/ and marketplace/ are siblings at the repo root (same resolution
	// marketplace-build.test.ts uses).
	const marketplaceDir = process.env.HEZO_MARKETPLACE_DIR;
	const agentsDir = marketplaceDir ? join(marketplaceDir, '..', 'agents') : null;

	it('references the shared partial from every agents/<team>/captain.md', () => {
		expect(agentsDir, 'HEZO_MARKETPLACE_DIR must be set in tests').toBeTruthy();
		if (!agentsDir || !existsSync(agentsDir)) return;

		const captainDocs = readdirSync(agentsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith('_'))
			.map((e) => ({ team: e.name, path: join(agentsDir, e.name, 'captain.md') }))
			.filter((c) => existsSync(c.path));

		// Blank plus the marketplace teams; if this ever drops to zero the guard is vacuous.
		expect(captainDocs.length).toBeGreaterThan(0);
		expect(captainDocs.map((c) => c.team)).toContain('blank');

		const offenders = captainDocs
			.filter((c) => !readFileSync(c.path, 'utf8').includes(PARTIAL_REF))
			.map((c) => `agents/${c.team}/captain.md`);

		expect(
			offenders,
			`These Captain docs are missing '${PARTIAL_REF}', so their teams would ship a Captain ` +
				'that never rebuilds the Progress page. Add the partial reference (see ' +
				'agents/blank/captain.md), then run build:agents and build:marketplace.',
		).toEqual([]);
	});

	it('carries the resolved guidance into the blank template the builtin Captain is seeded from', async () => {
		const { loadAgentRoles } = await import('../src/db/agent-roles');
		const roles = await loadAgentRoles();
		const blankCaptain = roles['blank/captain.md'];

		// The blank Captain is the base every team's Captain starts from, so the resolved text
		// (not just the reference) has to be there.
		expect(blankCaptain, 'blank/captain.md must ship in the agent roles').toBeTruthy();
		expect(blankCaptain).toContain('## Progress updates');
		expect(blankCaptain).toContain('update_project_progress');
		// Partials resolve at build time; an unresolved marker means the bundle is stale.
		expect(blankCaptain).not.toContain(PARTIAL_REF);
	});
});

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard: the QA Engineer is the pre-merge approval gate for the software-development
 * team. Its role doc MUST require the PR's CI to be green before it approves for
 * merge, where "green" means every required check has **finished executing** and
 * concluded `success` — not that a still-running run merely hasn't failed yet, and
 * not a wave-through of a red check as an "environment"/"infrastructure"/"flake"
 * issue. These are the two failure modes this gate exists to prevent (a QA agent
 * approved a PR for merge with red CI dismissed as environmental; another approved
 * on partial in-flight evidence — a Playwright *install* step passing and e2e
 * "now executing" — before the CI run had actually completed). The Engineer's
 * merge step carries the same precondition so the merge action itself is gated.
 *
 * We assert against the role-doc source (not the built bundle) so the guard reads
 * the current source of truth regardless of bundle freshness. If you intentionally
 * reword the gate, update these substrings — but keep the concept.
 */
const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'agents');

async function readRoleDoc(relPath: string): Promise<string> {
	return (await readFile(join(AGENTS_DIR, relPath), 'utf-8')).toLowerCase();
}

describe('software-development team enforces a CI-green merge gate', () => {
	it('QA role doc requires CI to be green before approving for merge', async () => {
		const text = await readRoleDoc('software-development/qa-engineer.md');

		// CI-green is a stated precondition to approval/merge (workflow step + hard rule).
		expect(text).toContain('ci is green');
		expect(text).toContain('ci must be green');
		// The gate is framed as a hard block, not advisory.
		expect(text).toContain('hard merge gate');
		// The "it's just an environment/infra/flake issue" loophole is explicitly closed.
		expect(text).toContain('environment');
		expect(text).toContain('flake');
	});

	it('requires all required checks to finish executing before approval (in-progress is not a pass)', async () => {
		const text = await readRoleDoc('software-development/qa-engineer.md');

		// CI passes only when every required check has *finished executing* — not
		// when a run merely hasn't failed yet, a sub-step passed, or a stage is
		// "now executing rather than erroring". An in-progress check is not a pass.
		expect(text).toContain('finished executing');
		expect(text).toContain('not a pass');
		expect(text).toContain('partial signals');
	});

	it('Engineer merge step is gated on CI being green and having finished', async () => {
		const text = await readRoleDoc('software-development/engineer.md');

		// The merge step must require green CI before merging, with no environmental exemption.
		expect(text).toContain('required ci check');
		expect(text).toContain('never merge a pr with a red');
		// And it must wait for checks to finish — a still-running check has not passed.
		expect(text).toContain('finished executing');
	});
});

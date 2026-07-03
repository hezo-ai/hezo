import { describe, expect, it } from 'vitest';
import { loadAgentRoles } from '../src/db/agent-roles';

/**
 * Guard: the QA Engineer is the pre-merge approval gate for the software-development
 * team. Its role doc MUST require the PR's CI to be green before it approves for
 * merge, and MUST refuse to wave a red check through as an "environment" /
 * "infrastructure" / "flake" issue — the exact failure this gate exists to
 * prevent (a QA agent once approved a PR for merge with red CI, dismissing the
 * failing check as environmental). The Engineer's merge step carries the same
 * CI-green precondition so the merge action itself is gated.
 *
 * These assertions lock in the behavioural contract so a future prompt edit
 * can't silently drop the CI merge gate. If you intentionally reword the gate,
 * update these substrings — but keep the concept.
 */
describe('software-development team enforces a CI-green merge gate', () => {
	it('QA role doc requires CI to be green before approving for merge', async () => {
		const roles = await loadAgentRoles();
		const qa = roles['software-development/qa-engineer.md'];
		expect(qa, 'software-development/qa-engineer.md must load').toBeTruthy();
		const text = qa.toLowerCase();

		// CI-green is a stated precondition to approval/merge (workflow step + hard rule).
		expect(text).toContain('ci is green');
		expect(text).toContain('ci must be green');
		// The gate is framed as a hard block, not advisory.
		expect(text).toContain('hard merge gate');
		// The "it's just an environment/infra/flake issue" loophole is explicitly closed.
		expect(text).toContain('environment');
		expect(text).toContain('flake');
	});

	it('Engineer merge step is gated on CI being green', async () => {
		const roles = await loadAgentRoles();
		const eng = roles['software-development/engineer.md'];
		expect(eng, 'software-development/engineer.md must load').toBeTruthy();
		const text = eng.toLowerCase();

		// The merge step must require green CI before merging, with no environmental exemption.
		expect(text).toContain('required ci check');
		expect(text).toContain('never merge a pr with a red');
	});
});

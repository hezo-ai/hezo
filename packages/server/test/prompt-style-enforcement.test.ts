import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	authoredPromptError,
	authoredPromptWarning,
	findSharedInstructionDuplicates,
	resetSharedInstructionBullets,
} from '../src/services/prompt-style-guard';
import { SHARED_INSTRUCTIONS_TEXT } from '../src/services/template-resolver';

/**
 * Guard: every surface that accepts an authored prompt runs the house register.
 *
 * The reach rule this enforces is AGENTS.md § Layout - state a rule once, in
 * the highest-reaching surface that covers its audience. A role prompt that
 * repeats a SHARED_INSTRUCTIONS bullet is pure duplication, and the copy is
 * what goes stale (which is how qa-engineer.md and engineer.md ended up with
 * opposite models of the phased-merge protocol).
 */
describe('duplicates-SHARED_INSTRUCTIONS detection', () => {
	beforeAll(() => resetSharedInstructionBullets());
	afterAll(() => resetSharedInstructionBullets());

	/** A real bullet from the shared guidance, taken live so it cannot go stale. */
	function aSharedBullet(): string {
		const bullet = SHARED_INSTRUCTIONS_TEXT.split('\n').find(
			(l) => /^-\s+\*\*/.test(l) && l.split(/\s+/).length > 25,
		);
		if (!bullet) throw new Error('no comparable bullet found in SHARED_INSTRUCTIONS');
		return bullet;
	}

	it('flags a bullet copied verbatim out of the shared guidance', () => {
		const findings = findSharedInstructionDuplicates(`# Role\n\n${aSharedBullet()}\n`);
		expect(findings).toHaveLength(1);
		expect(findings[0].rule).toBe('duplicates_shared');
		expect(findings[0].severity).toBe('error');
	});

	it('flags it through the same decoration differences a re-typing introduces', () => {
		const restyled = aSharedBullet().replace(/\*\*/g, '').replace(/^-\s+/, '-   ');
		expect(findSharedInstructionDuplicates(restyled)).toHaveLength(1);
	});

	it('leaves a role-specific rule alone', () => {
		const own =
			'- **Never merge a PR with a red required check.** Fix CI on the branch and hand back to QA.';
		expect(findSharedInstructionDuplicates(own)).toEqual([]);
	});

	it('ignores prose and short bullets, which cannot match meaningfully', () => {
		expect(findSharedInstructionDuplicates('Read the thread before you act.')).toEqual([]);
		expect(findSharedInstructionDuplicates('- Do it now.')).toEqual([]);
	});
});

describe('authoredPromptError', () => {
	it('rejects the mechanical violations and nothing else', () => {
		expect(authoredPromptError('- Read `prd.md` first.')).toContain('prd.md');
		expect(
			authoredPromptError('- Wrap it in `withTransaction`.', { marketplaceReaching: true }),
		).toContain('withTransaction');
		// Length and vocabulary are judgement calls: they never block a write.
		expect(authoredPromptError(`- Generally, ${'word '.repeat(80)}`)).toBeNull();
	});

	it('returns null for a prompt written to the register', () => {
		expect(
			authoredPromptError('- **Post the active mention.** A passive one wakes nobody.', {
				marketplaceReaching: true,
			}),
		).toBeNull();
	});
});

describe('authoredPromptWarning', () => {
	it('advises on the judgement calls and names how to fix them', () => {
		const warning = authoredPromptWarning(`- Generally, ${'word '.repeat(80)}`);
		expect(warning).toContain('saved');
		expect(warning).toContain('update tool');
	});

	it('is null when the prompt is clean, so a caller can spread it away', () => {
		expect(
			authoredPromptWarning('- **Post the active mention.** A passive one wakes nobody.'),
		).toBeNull();
	});
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '../../..');

/**
 * AGENTS.md is the contributor-guidelines file for working on this repo - what a
 * human or coding agent reads before changing this codebase. It is not part of
 * Hezo's product runtime: nothing in it is injected into Hezo's agents when they
 * run tasks for users (that is `SHARED_INSTRUCTIONS`, a separate surface with its
 * own ceiling). The cost this guards is comprehension, not tokens - a rules file
 * too long to hold while working is a rules file that stops being followed.
 *
 * This is a ratchet, not a target. It was introduced at 100_000, just above the
 * file's size at the time. The extraction pass that moved the specialized areas
 * into `.dev/` guides landed it near 33_000, so the number came down with it. Each
 * such pass re-ratchets to roughly the landed size plus a little room: enough that
 * a genuinely new rule fits, not enough for a section to accrete.
 *
 * Raising it is a decision to make deliberately, in a commit that says why, rather
 * than the automatic outcome of adding a paragraph.
 */
const AGENTS_MD_BUDGET_BYTES = 36_000;

/**
 * The relief valve the routing table at the top of AGENTS.md already names, so a
 * failure has somewhere to send you that is not "delete a rule".
 */
const HOW_TO_GET_UNDER = [
	'Cut an existing entry down - the file asks for this explicitly, and most entries still carry',
	'  hedges, restatements and examples that only re-illustrate the rule above them.',
	'Move rationale to `.dev/`. A rule needing a paragraph of context is two things: the rule in',
	'  AGENTS.md, the context in a `.dev/*.md`.',
	'Move a whole specialized area to a `.dev/<doing-the-thing>.md` guide, leaving behind only the',
	'  trip-wires that bind someone who does not yet know they are in that territory.',
].join('\n  ');

describe('AGENTS.md size budget', () => {
	it('stays within its byte budget', () => {
		const bytes = Buffer.byteLength(readFileSync(join(REPO_ROOT, 'AGENTS.md')));
		expect(
			bytes,
			`AGENTS.md is ${bytes} bytes, over its ${AGENTS_MD_BUDGET_BYTES}-byte budget by ${
				bytes - AGENTS_MD_BUDGET_BYTES
			}.\n\n` +
				`  Every agent working in this repo reads this file on every task, so it is a context\n` +
				`  cost paid on every run - the same reason the prompt surfaces have ceilings.\n\n` +
				`  Three ways down:\n  ${HOW_TO_GET_UNDER}\n\n` +
				`  Raising the budget is a deliberate call. If that is the right answer, say why in the\n` +
				`  commit rather than nudging the number to make this pass.`,
		).toBeLessThanOrEqual(AGENTS_MD_BUDGET_BYTES);
	});

	it('keeps CLAUDE.md a pointer rather than a second copy', () => {
		// CLAUDE.md is `@AGENTS.md` and nothing else. A rule pasted into it would be
		// a second home for the same text, which is the duplication AGENTS.md bans.
		const claude = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8').trim();
		expect(claude).toBe('@AGENTS.md');
	});
});

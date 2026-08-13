import { describe, expect, it } from 'vitest';
import {
	checkPromptStyle,
	isComparableBullet,
	MAX_BULLET_WORDS,
	MAX_SENTENCE_WORDS,
	normalizeBullet,
	PROMPT_STYLE_RULES,
	promptStyleError,
	promptStyleErrors,
	promptStyleWarnings,
	renderPromptStyleRules,
} from '../src/prompt-style';

/**
 * The machine-checkable half of the writing register
 * (`.dev/writing-agent-prompts.md`). The severity split is the contract worth
 * guarding: mechanical violations reject a write, judgement calls come back as
 * an advisory. A heuristic that hard-rejects would trap an agent retrying
 * against a rule it cannot satisfy.
 */
describe('checkPromptStyle severity split', () => {
	it('rejects a backticked project-doc filename but allows genuine repo files', () => {
		const errs = promptStyleErrors('- Read `prd.md` before you start.');
		expect(errs).toHaveLength(1);
		expect(errs[0].rule).toBe('backticked_doc');
		expect(errs[0].line).toBe(1);

		// AGENTS.md and friends really are repo files, so backticks are correct.
		expect(promptStyleErrors('- Read `AGENTS.md` for conventions.')).toEqual([]);
		// A path with a folder is a repo path, not a doc handle.
		expect(promptStyleErrors('- See `docs/reference/cli.md`.')).toEqual([]);
	});

	it('rejects a Hezo-internal symbol only in a marketplace-reaching prompt', () => {
		const text = '- Wrap the write in `withTransaction` and read `packages/shared` first.';
		expect(promptStyleErrors(text, { marketplaceReaching: true }).map((f) => f.rule)).toEqual([
			'hezo_internal',
			'hezo_internal',
		]);
		// An operator writing about their own codebase is not shipping anywhere.
		expect(promptStyleErrors(text)).toEqual([]);
	});

	it('leaves AGENTS.md and hezo/<TASK> alone even when marketplace-reaching', () => {
		const text = '- Read the repo AGENTS.md, then push to hezo/<TASK>.';
		expect(promptStyleErrors(text, { marketplaceReaching: true })).toEqual([]);
	});

	it('warns, never rejects, on length and vocabulary', () => {
		const long = `- ${'word '.repeat(MAX_BULLET_WORDS + 5)}`;
		const warnings = promptStyleWarnings(long);
		expect(warnings.some((w) => w.rule === 'one_rule_per_bullet')).toBe(true);
		expect(promptStyleErrors(long)).toEqual([]);

		const hedged = '- Generally you should check the thread first.';
		expect(promptStyleWarnings(hedged).some((w) => w.rule === 'hedge')).toBe(true);
		expect(promptStyleErrors(hedged)).toEqual([]);

		const loud = '- Use sub-agents aggressively when exploring.';
		expect(promptStyleWarnings(loud).some((w) => w.rule === 'intensifier')).toBe(true);
	});

	it('flags a sentence over the ceiling once per line', () => {
		const sentence = `- ${'word '.repeat(MAX_SENTENCE_WORDS + 3)}.`;
		const long = checkPromptStyle(sentence).filter((f) => f.rule === 'long_sentence');
		expect(long).toHaveLength(1);
		expect(long[0].message).toContain(`max ${MAX_SENTENCE_WORDS}`);
	});

	it('accepts a bullet written to the register', () => {
		const good =
			'- **Post the active mention.** A passive reference wakes nobody and the task stalls.';
		expect(checkPromptStyle(good, { marketplaceReaching: true })).toEqual([]);
	});
});

/**
 * The rules do not apply inside regions that are not prose. A table row or a
 * fenced command is allowed to be long, and the trailing `{{...}}` block every
 * role doc ends with is mechanical.
 */
describe('checkPromptStyle skips non-prose regions', () => {
	it('ignores fenced code, tables, markers and substitution lines', () => {
		const text = [
			'```sh',
			`git commit -m "${'x'.repeat(400)}"`,
			'```',
			`| col | ${'very long cell '.repeat(20)} |`,
			'<!-- HEZO_DOCS: a marker -->',
			'{{skills_context}}',
			'{{> partials/common/repo-work}}',
		].join('\n');
		expect(checkPromptStyle(text, { marketplaceReaching: true })).toEqual([]);
	});

	it('does not count inline code or placeholders toward the word budget', () => {
		const text = `- Call \`${'a'.repeat(200)}\` with {{team_name}} and stop.`;
		expect(promptStyleWarnings(text)).toEqual([]);
	});
});

describe('normalizeBullet', () => {
	it('collapses decoration so two spellings of one rule match', () => {
		const a = '- **Post the active `@<slug>`** - it is the only wake there is.';
		const b = '-   Post the active @<slug>, it is the only wake there is.';
		expect(normalizeBullet(a)).toBe(normalizeBullet(b));
	});

	it('requires enough words for a match to mean something', () => {
		expect(isComparableBullet(normalizeBullet('- Do it.'))).toBe(false);
		expect(
			isComparableBullet(normalizeBullet('- Post the active mention before you end the turn now.')),
		).toBe(true);
	});
});

describe('the rule list agents are shown', () => {
	it('renders every rule as its own line', () => {
		const rendered = renderPromptStyleRules();
		expect(rendered.split('\n')).toHaveLength(PROMPT_STYLE_RULES.length);
		for (const rule of PROMPT_STYLE_RULES) expect(rendered).toContain(rule.summary);
	});

	it('covers every rule the checker can emit, so the prompt cannot drift from enforcement', () => {
		const emitted = new Set(
			checkPromptStyle(
				[
					'- Read `prd.md` and use `withTransaction`.',
					`- Generally, ${'word '.repeat(MAX_BULLET_WORDS + 5)}`,
					'- Use sub-agents aggressively.',
				].join('\n'),
				{ marketplaceReaching: true },
			).map((f) => f.rule),
		);
		const documented = new Set(PROMPT_STYLE_RULES.map((r) => r.id));
		for (const rule of emitted) expect(documented, rule).toContain(rule);
	});
});

describe('promptStyleError', () => {
	it('names every error and returns null when clean', () => {
		const msg = promptStyleError('- Read `prd.md` first.');
		expect(msg).toContain('prd.md');
		expect(promptStyleError('- Read prd.md first.')).toBeNull();
	});
});

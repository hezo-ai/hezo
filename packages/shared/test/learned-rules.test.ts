import { describe, expect, it } from 'vitest';
import {
	countLearnedRules,
	learnedRulesCapError,
	learnedRulesOnlyChange,
	MAX_LEARNED_RULES,
	splitLearnedRules,
} from '../src/documents/learned-rules';

const ROLE = '# Analyst\n\nYou analyse things.\n\n- Keep it short.\n';
const withRules = (n: number, role = ROLE) =>
	`${role}\n## Learned Rules\n\n${Array.from({ length: n }, (_, i) => `- Rule ${i + 1}.\n  Detail under it.`).join('\n')}\n`;

describe('countLearnedRules', () => {
	it('counts top-level bullets under the heading, not the role text or nested lines', () => {
		expect(countLearnedRules(ROLE)).toBe(0);
		expect(countLearnedRules(withRules(3))).toBe(3);
	});
});

describe('splitLearnedRules', () => {
	it('separates the role text from its rules', () => {
		const { body, rules } = splitLearnedRules(withRules(2));
		expect(body).toBe(ROLE.trimEnd());
		expect(rules.startsWith('## Learned Rules')).toBe(true);
	});
});

describe('learnedRulesOnlyChange', () => {
	it('is true when only the rules moved, false when the role text did', () => {
		expect(learnedRulesOnlyChange(withRules(2), withRules(3))).toBe(true);
		expect(learnedRulesOnlyChange(withRules(2), withRules(2, `${ROLE}- New duty.\n`))).toBe(false);
		expect(learnedRulesOnlyChange(withRules(2), withRules(2))).toBe(false);
	});
});

describe('learnedRulesCapError', () => {
	it('refuses a write that passes the cap and grows the section', () => {
		expect(
			learnedRulesCapError(withRules(MAX_LEARNED_RULES), withRules(MAX_LEARNED_RULES)),
		).toBeNull();
		expect(
			learnedRulesCapError(withRules(MAX_LEARNED_RULES), withRules(MAX_LEARNED_RULES + 1)),
		).toMatch(/at most 20 rules/);
		expect(learnedRulesCapError(null, withRules(MAX_LEARNED_RULES + 1))).not.toBeNull();
	});

	it('lets a prompt already over the cap be written down towards it', () => {
		expect(learnedRulesCapError(withRules(77), withRules(60))).toBeNull();
		expect(learnedRulesCapError(withRules(77), withRules(77))).toBeNull();
		expect(learnedRulesCapError(withRules(77), withRules(78))).not.toBeNull();
	});
});

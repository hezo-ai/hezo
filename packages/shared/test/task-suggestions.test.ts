import { describe, expect, it } from 'vitest';
import {
	TASK_SUGGESTION_KIND_RULES,
	TaskSuggestionKind,
	validateCadenceChoice,
	validateSuggestedCadence,
} from '../src/task-suggestions';

const KINDS = Object.values(TaskSuggestionKind);
const REPEATING = ['daily', 'weekly', 'monthly'] as const;

describe('validateSuggestedCadence', () => {
	it('covers every kind with a rule', () => {
		expect(Object.keys(TASK_SUGGESTION_KIND_RULES).sort()).toEqual([...KINDS].sort());
	});

	for (const kind of KINDS) {
		const rule = TASK_SUGGESTION_KIND_RULES[kind].cadence;

		it(`${kind} (${rule}): no cadence`, () => {
			const error = validateSuggestedCadence(kind, undefined);
			if (rule === 'required') expect(error).toMatch(/needs a cadence/);
			else expect(error).toBeNull();
		});

		it(`${kind} (${rule}): a repeating cadence`, () => {
			for (const cadence of REPEATING) {
				const error = validateSuggestedCadence(kind, cadence);
				if (rule === 'forbidden') expect(error).toMatch(/does not repeat/);
				else expect(error).toBeNull();
			}
		});

		it(`${kind} (${rule}): "once" or an unknown value is never the CEO's to send`, () => {
			expect(validateSuggestedCadence(kind, 'once')).toMatch(/daily, weekly or monthly/);
			expect(validateSuggestedCadence(kind, 'hourly')).toMatch(/daily, weekly or monthly/);
		});
	}

	it('names the kinds that do not repeat', () => {
		expect(
			KINDS.filter((k) => TASK_SUGGESTION_KIND_RULES[k].cadence === 'forbidden').sort(),
		).toEqual(['admin_input', 'connection', 'deliverable']);
	});
});

describe('validateCadenceChoice', () => {
	it('accepts any of the four choices on a card the CEO gave a cadence', () => {
		for (const choice of ['daily', 'weekly', 'monthly', 'once']) {
			expect(validateCadenceChoice('weekly', choice)).toBeNull();
		}
	});

	it('refuses a choice on a card with no cadence', () => {
		expect(validateCadenceChoice(null, 'weekly')).toMatch(/does not repeat/);
		expect(validateCadenceChoice(undefined, 'once')).toMatch(/does not repeat/);
	});

	it('refuses an unknown value', () => {
		expect(validateCadenceChoice('daily', 'hourly')).toMatch(/daily, weekly, monthly or once/);
		expect(validateCadenceChoice('daily', 3)).toMatch(/daily, weekly, monthly or once/);
	});
});

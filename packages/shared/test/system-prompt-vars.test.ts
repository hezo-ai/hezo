import { describe, expect, it } from 'vitest';
import {
	IDENTITY_BLOCK_VARS,
	LIVE_CONTEXT_BLOCK_VARS,
	SYSTEM_PROMPT_TEMPLATE_VARS,
	SYSTEM_PROMPT_VAR_TRIGGER,
} from '../src/system-prompt-vars';

const tokens = SYSTEM_PROMPT_TEMPLATE_VARS.map((v) => v.token);

describe('SYSTEM_PROMPT_TEMPLATE_VARS', () => {
	it('offers the six variables the resolver still substitutes', () => {
		expect(tokens).toEqual([
			'{{team_name}}',
			'{{reports_to}}',
			'{{current_date}}',
			'{{skills_context}}',
			'{{team_preferences_context}}',
			'{{project_docs_context}}',
		]);
	});

	it('drops the retired tokens', () => {
		// team_context double-printed the appended "Your Team" block; the composed
		// identity block writes the team description in directly. Neither is
		// offered as something an author can place.
		expect(tokens).not.toContain('{{team_context}}');
		expect(tokens).not.toContain('{{team_description}}');
		expect(tokens).not.toContain('{{team_mission}}');
	});

	it('gives every var a non-empty description', () => {
		for (const v of SYSTEM_PROMPT_TEMPLATE_VARS) {
			expect(v.description.length).toBeGreaterThan(0);
		}
	});

	it('has no duplicate tokens', () => {
		expect(new Set(tokens).size).toBe(tokens.length);
	});
});

describe('composed-block registries', () => {
	it('names only offered tokens, so the lookup can reach every one', () => {
		for (const token of [...IDENTITY_BLOCK_VARS, ...LIVE_CONTEXT_BLOCK_VARS]) {
			expect(tokens).toContain(token);
		}
	});

	it('keeps the two blocks disjoint', () => {
		const overlap = IDENTITY_BLOCK_VARS.filter((t) => LIVE_CONTEXT_BLOCK_VARS.includes(t));
		expect(overlap).toEqual([]);
	});

	it('covers every offered token between them', () => {
		// A token in neither block would be offered by the lookup while nothing
		// supplies it automatically - the gap this whole design closes.
		expect([...IDENTITY_BLOCK_VARS, ...LIVE_CONTEXT_BLOCK_VARS].sort()).toEqual([...tokens].sort());
	});
});

describe('SYSTEM_PROMPT_VAR_TRIGGER', () => {
	it('is the opening of every token, so typing it matches them all', () => {
		expect(SYSTEM_PROMPT_VAR_TRIGGER).toBe('{{');
		for (const token of tokens) expect(token.startsWith(SYSTEM_PROMPT_VAR_TRIGGER)).toBe(true);
	});
});

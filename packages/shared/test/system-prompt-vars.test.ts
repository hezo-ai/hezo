import { describe, expect, it } from 'vitest';
import {
	findMissingRequiredSystemPromptVars,
	REQUIRED_SYSTEM_PROMPT_VARS,
	requiredSystemPromptVarsError,
	SYSTEM_PROMPT_TEMPLATE_VARS,
} from '../src/system-prompt-vars';

/** A prompt that contains every required var. */
const compliant = REQUIRED_SYSTEM_PROMPT_VARS.map((t) => `Use ${t} here.`).join('\n');

describe('SYSTEM_PROMPT_TEMPLATE_VARS', () => {
	it('lists the five required vars and only them as required', () => {
		expect(REQUIRED_SYSTEM_PROMPT_VARS).toEqual([
			'{{team_name}}',
			'{{reports_to}}',
			'{{skills_context}}',
			'{{project_docs_context}}',
			'{{team_preferences_context}}',
		]);
	});

	it('does not list the removed team_mission var', () => {
		expect(SYSTEM_PROMPT_TEMPLATE_VARS.some((v) => v.token === '{{team_mission}}')).toBe(false);
	});

	it('gives every var a non-empty description', () => {
		for (const v of SYSTEM_PROMPT_TEMPLATE_VARS) {
			expect(v.description.length).toBeGreaterThan(0);
		}
	});
});

describe('findMissingRequiredSystemPromptVars', () => {
	it('returns [] for a compliant prompt', () => {
		expect(findMissingRequiredSystemPromptVars(compliant)).toEqual([]);
	});

	it('returns every missing required var in canonical order', () => {
		expect(findMissingRequiredSystemPromptVars('You are an agent.')).toEqual([
			...REQUIRED_SYSTEM_PROMPT_VARS,
		]);
	});

	it('flags only the specific missing var', () => {
		const withoutSkills = compliant.replace('{{skills_context}}', '(removed)');
		expect(findMissingRequiredSystemPromptVars(withoutSkills)).toEqual(['{{skills_context}}']);
	});

	it('treats an empty prompt as missing everything', () => {
		expect(findMissingRequiredSystemPromptVars('')).toEqual([...REQUIRED_SYSTEM_PROMPT_VARS]);
	});
});

describe('requiredSystemPromptVarsError', () => {
	it('returns null for a compliant prompt', () => {
		expect(requiredSystemPromptVarsError(compliant)).toBeNull();
	});

	it('names the missing vars in the message', () => {
		const msg = requiredSystemPromptVarsError('You are an agent.');
		expect(msg).toContain('{{team_name}}');
		expect(msg).toContain('{{team_preferences_context}}');
	});
});

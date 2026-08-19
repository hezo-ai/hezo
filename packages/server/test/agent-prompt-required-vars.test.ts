import { findMissingRequiredSystemPromptVars, REQUIRED_SYSTEM_PROMPT_VARS } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { loadAgentRoles } from '../src/db/agent-roles';

/**
 * Guard: every hireable (team-template) role doc Hezo ships must already
 * satisfy the required-substitution-variable rule the authoring surfaces
 * enforce — otherwise editing a seeded prompt would fail its own validation.
 * Instance singletons (`_instance/*` — CEO/Coach) are exempt: they have no
 * in-team manager, so `{{reports_to}}` does not apply to them.
 */
describe('shipped role docs satisfy the required system-prompt variables', () => {
	it('every team-template role doc contains all required vars', async () => {
		const roles = await loadAgentRoles();
		const hireable = Object.entries(roles).filter(
			([path]) => path.startsWith('app-dev/') || path.startsWith('blank/'),
		);
		expect(hireable.length).toBeGreaterThan(0);

		const offenders = hireable
			.map(([path, content]) => ({ path, missing: findMissingRequiredSystemPromptVars(content) }))
			.filter((r) => r.missing.length > 0);

		expect(
			offenders,
			`These shipped role docs are missing required vars (must contain ${REQUIRED_SYSTEM_PROMPT_VARS.join(
				', ',
			)}): ${JSON.stringify(offenders)}`,
		).toEqual([]);
	});
});

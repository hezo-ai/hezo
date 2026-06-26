import { REQUIRED_SYSTEM_PROMPT_VARS } from '@hezo/shared';

/**
 * Append the required substitution variables to a test prompt body so it passes
 * the authoring-surface validation. The body text is preserved, so assertions
 * that check for specific prose still hold.
 */
export function compliantPrompt(body: string): string {
	return `${body}\n\n${REQUIRED_SYSTEM_PROMPT_VARS.join('\n')}`;
}

/** A ready-made compliant system prompt for tests that don't assert on its body. */
export const COMPLIANT_SYSTEM_PROMPT = compliantPrompt('You are a test agent.');

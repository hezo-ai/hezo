/**
 * Single source of truth for the `{{...}}` substitution variables an agent
 * system-prompt template may contain. The server resolver
 * (`template-resolver.ts`) fills these with live data at run time; this module
 * describes them for the authoring surfaces (web hire form chips, agent-facing
 * tool docs) and provides the required-variable validation shared by every
 * surface that lets a human or agent author/edit a prompt.
 *
 * Keep this list aligned with the placeholders the resolver actually handles.
 */

export interface SystemPromptVar {
	/** The literal placeholder token, e.g. `{{team_name}}`. */
	token: string;
	/** Human/agent-facing explanation of what the variable resolves to. */
	description: string;
	/**
	 * When true, every authored/edited prompt must contain this token or the
	 * save is rejected. The required set anchors the agent's identity and the
	 * live context (skills, project docs, team preferences) it relies on.
	 */
	required: boolean;
}

/**
 * Every substitution variable an authored prompt may use, in display order.
 * Retired (`kb_context`), blanked (`requester_context`), and CEO-only
 * (`projects_context`) placeholders are intentionally omitted — they are not
 * relevant to authoring a team agent's prompt.
 */
export const SYSTEM_PROMPT_TEMPLATE_VARS: readonly SystemPromptVar[] = [
	{
		token: '{{team_name}}',
		description: "The team's name.",
		required: true,
	},
	{
		token: '{{reports_to}}',
		description: "The display name of the agent's manager (who it reports to).",
		required: true,
	},
	{
		token: '{{skills_context}}',
		description:
			'A live manifest of the team skills database (name + slug of each active skill) so the agent can load full instructions on demand.',
		required: true,
	},
	{
		token: '{{project_docs_context}}',
		description:
			'A live manifest of the project documentation (PRDs, specs, research) so the agent can read any doc on demand.',
		required: true,
	},
	{
		token: '{{team_preferences_context}}',
		description: "The team's saved preferences and conventions.",
		required: true,
	},
	{
		token: '{{team_description}}',
		description: "The team's description.",
		required: false,
	},
	{
		token: '{{team_context}}',
		description:
			"The agent's view of the team (org chart / teammates). Injected automatically on every run even when omitted, so it is optional in the template.",
		required: false,
	},
	{
		token: '{{current_date}}',
		description: "Today's date (YYYY-MM-DD).",
		required: false,
	},
];

/** The tokens that every authored/edited prompt must contain. */
export const REQUIRED_SYSTEM_PROMPT_VARS: readonly string[] = SYSTEM_PROMPT_TEMPLATE_VARS.filter(
	(v) => v.required,
).map((v) => v.token);

/**
 * Returns the required tokens missing from `prompt`, in canonical order. An
 * empty array means the prompt satisfies the requirement. Matching mirrors the
 * resolver's own `includes('{{x}}')` style.
 */
export function findMissingRequiredSystemPromptVars(prompt: string): string[] {
	return REQUIRED_SYSTEM_PROMPT_VARS.filter((token) => !prompt.includes(token));
}

/**
 * Human-readable error message naming the missing required vars, suitable for a
 * 4xx response or an agent-facing tool error. Returns null when nothing is
 * missing.
 */
export function requiredSystemPromptVarsError(prompt: string): string | null {
	const missing = findMissingRequiredSystemPromptVars(prompt);
	if (missing.length === 0) return null;
	return `System prompt is missing required substitution variable(s): ${missing.join(', ')}. Every agent prompt must include all of: ${REQUIRED_SYSTEM_PROMPT_VARS.join(', ')}.`;
}

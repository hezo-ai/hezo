/**
 * Single source of truth for the `{{...}}` substitution variables an agent
 * system-prompt template may contain. The server resolver
 * (`template-resolver.ts`) fills these with live data at run time; this module
 * describes them for the authoring surfaces (the web editor's reference strip
 * and its `{{` insertion lookup, agent-facing tool docs).
 *
 * **None of them are required.** The resolver composes an identity block above
 * the authored body and a live-context block below it, adding only the pieces
 * the template does not already carry, so a prompt that names no variable at
 * all still reaches its agent with identity, skills, preferences and project
 * docs. A variable is therefore only ever a way to put one of those values at a
 * chosen point in the author's own prose, which suppresses Hezo's own copy of
 * it. See `.dev/architecture.md` for the composition rules.
 *
 * Keep this list aligned with the placeholders the resolver actually handles.
 */

export interface SystemPromptVar {
	/** The literal placeholder token, e.g. `{{team_name}}`. */
	token: string;
	/** Human/agent-facing explanation of what the variable resolves to. */
	description: string;
}

/**
 * Every substitution variable an authored prompt may use, in display order.
 *
 * Omitted deliberately: `kb_context` (retired), `requester_context` (blanked),
 * `team_context` (retired - the "Your Team" block is appended on every run
 * whether or not a template asks, so the token only ever double-printed it),
 * `team_description` (the composed identity block writes it in directly), and
 * `projects_context` (CEO-only, not relevant to authoring a team agent).
 */
export const SYSTEM_PROMPT_TEMPLATE_VARS: readonly SystemPromptVar[] = [
	{
		token: '{{team_name}}',
		description: "The team's name.",
	},
	{
		token: '{{reports_to}}',
		description: "The display name of the agent's manager (who it reports to).",
	},
	{
		token: '{{current_date}}',
		description: "Today's date (YYYY-MM-DD).",
	},
	{
		token: '{{skills_context}}',
		description:
			'A live manifest of the team skills database (name + slug of each active skill) so the agent can load full instructions on demand.',
	},
	{
		token: '{{team_preferences_context}}',
		description: "The team's saved preferences and conventions.",
	},
	{
		token: '{{project_docs_context}}',
		description:
			'A live manifest of the project documentation (PRDs, specs, research) so the agent can read any doc on demand.',
	},
];

/** The trigger that opens the variable lookup in an authoring textarea. */
export const SYSTEM_PROMPT_VAR_TRIGGER = '{{';

/**
 * The variables whose value the composed identity block carries. A template
 * naming either one states its own identity, so the block is skipped whole
 * rather than duplicating the author's opening line.
 */
export const IDENTITY_BLOCK_VARS: readonly string[] = ['{{team_name}}', '{{reports_to}}'];

/**
 * The variables the composed live-context block carries, in the order it emits
 * them. Each line is skipped on its own when the template already names it.
 */
export const LIVE_CONTEXT_BLOCK_VARS: readonly string[] = [
	'{{current_date}}',
	'{{skills_context}}',
	'{{team_preferences_context}}',
	'{{project_docs_context}}',
];

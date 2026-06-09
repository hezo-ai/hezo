export const DEFAULT_PORT = 3100;
export const DEFAULT_WEB_PORT = 5173;
export const DEFAULT_DATA_DIR = '~/.hezo';
export const CANARY_PLAINTEXT = 'CANARY';
export const CAPTAIN_AGENT_SLUG = 'captain';
/** Instance-level Coach role: one per Hezo instance, reviews completed work across every project. */
export const COACH_AGENT_SLUG = 'coach';
/** Instance-level CEO role: one per Hezo instance, sits above every team Captain. */
export const CEO_AGENT_SLUG = 'ceo';
/** Roles seeded into every project-team. Coach and CEO are instance-level, not per-team. */
export const BUILTIN_AGENT_SLUGS = [CAPTAIN_AGENT_SLUG] as const;
/** Instance-level singletons living in the HQ team, never duplicated per project-team. */
export const INSTANCE_AGENT_SLUGS = [CEO_AGENT_SLUG, COACH_AGENT_SLUG] as const;

export const ADMIN_MENTION_SLUG = 'admin';
export const RESERVED_AGENT_SLUGS = [ADMIN_MENTION_SLUG] as const;
export function isReservedAgentSlug(slug: string): boolean {
	return (RESERVED_AGENT_SLUGS as readonly string[]).includes(slug);
}
/**
 * The single instance-level coordination project, living in the HQ (default)
 * team. There is exactly one across the instance — it hosts the CEO + Coach and
 * the pre-creation project-intake conversations. Normal project-teams have no
 * internal project of their own.
 */
export const HQ_PROJECT_SLUG = 'hq';
export const HQ_PROJECT_NAME = 'HQ';
export const HQ_PROJECT_TASK_PREFIX = 'HQ';

export const DEFAULT_TEAM_ID = '00000000-0000-0000-0000-000000000001';
export const DEFAULT_TEAM_SLUG = 'default';
export const DEFAULT_TEAM_NAME = 'Team';
export const DEFAULT_TEAM_TEMPLATE_NAME = 'Blank';

export const PROJECT_INTAKE_LABEL = 'project-intake';
export const PROJECT_INTAKE_SKIP_SIGNAL_TEXT =
	'Admin chose to skip further questions — finalise the project proposal with what we have so far.';

export const wsRoom = {
	team: (id: string) => `team:${id}`,
	agent: (id: string) => `agent:${id}`,
	/** The single global CEO chat room. Every mirrored surface subscribes here. */
	ceo: () => 'ceo:global',
} as const;

/**
 * Conventional-commit type → changelog heading, in render order. Single source
 * of truth shared by the release script and its tests. Commit types not listed
 * here (and non-conventional commits) fall into the "Other" section.
 */
export const CHANGELOG_SECTIONS = [
	['feat', 'Features'],
	['fix', 'Bug Fixes'],
	['perf', 'Performance'],
	['refactor', 'Refactors'],
	['docs', 'Documentation'],
	['build', 'Build System'],
	['test', 'Tests'],
	['chore', 'Chores'],
] as const;

export const CHANGELOG_OTHER_HEADING = 'Other';
export const CHANGELOG_BREAKING_HEADING = 'Breaking Changes';

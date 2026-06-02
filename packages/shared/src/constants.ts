export const DEFAULT_PORT = 3100;
export const DEFAULT_WEB_PORT = 5173;
export const DEFAULT_DATA_DIR = '~/.hezo';
export const CANARY_PLAINTEXT = 'CANARY';
export const CAPTAIN_AGENT_SLUG = 'captain';
export const COACH_AGENT_SLUG = 'coach';
export const BUILTIN_AGENT_SLUGS = [CAPTAIN_AGENT_SLUG, COACH_AGENT_SLUG] as const;

export const BOARD_MENTION_SLUG = 'board';
export const RESERVED_AGENT_SLUGS = [BOARD_MENTION_SLUG] as const;
export function isReservedAgentSlug(slug: string): boolean {
	return (RESERVED_AGENT_SLUGS as readonly string[]).includes(slug);
}
export const INTERNAL_PROJECT_SLUG = 'internal';
export const INTERNAL_PROJECT_TASK_PREFIX = 'IN';

export const DEFAULT_TEAM_ID = '00000000-0000-0000-0000-000000000001';
export const DEFAULT_TEAM_SLUG = 'default';
export const DEFAULT_TEAM_NAME = 'Team';
export const DEFAULT_TEAM_TEMPLATE_NAME = 'Blank';

export const ONBOARDING_INTAKE_SKIP_SIGNAL_TEXT =
	'Board chose to skip further questions — propose a template and a project based on what we have so far.';

export const PROJECT_INTAKE_LABEL = 'project-intake';
export const PROJECT_INTAKE_SKIP_SIGNAL_TEXT =
	'Board chose to skip further questions — finalise the project proposal with what we have so far.';

export const wsRoom = {
	team: (id: string) => `team:${id}`,
	agent: (id: string) => `agent:${id}`,
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

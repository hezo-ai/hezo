export const DEFAULT_PORT = 3100;
export const DEFAULT_WEB_PORT = 5173;
export const DEFAULT_DATA_DIR = '~/.hezo';
export const CANARY_PLAINTEXT = 'CANARY';
export const CEO_AGENT_SLUG = 'ceo';
export const COACH_AGENT_SLUG = 'coach';
export const BUILTIN_AGENT_SLUGS = [CEO_AGENT_SLUG, COACH_AGENT_SLUG] as const;
export const OPERATIONS_PROJECT_SLUG = 'operations';

export const DEFAULT_TEAM_ID = '00000000-0000-0000-0000-000000000001';
export const DEFAULT_TEAM_SLUG = 'default';
export const DEFAULT_TEAM_NAME = 'Team';
export const DEFAULT_TEAM_TEMPLATE_NAME = 'Startup';

export const wsRoom = {
	team: (id: string) => `team:${id}`,
	agent: (id: string) => `agent:${id}`,
} as const;

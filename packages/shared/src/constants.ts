export const DEFAULT_PORT = 3100;
export const DEFAULT_WEB_PORT = 5173;
export const DEFAULT_DATA_DIR = '~/.hezo';
export const CANARY_PLAINTEXT = 'CANARY';
export const CEO_AGENT_SLUG = 'ceo';
export const COACH_AGENT_SLUG = 'coach';
export const BUILTIN_AGENT_SLUGS = [CEO_AGENT_SLUG, COACH_AGENT_SLUG] as const;
export const OPERATIONS_PROJECT_SLUG = 'operations';

export const wsRoom = {
	company: (id: string) => `company:${id}`,
	agent: (id: string) => `agent:${id}`,
} as const;

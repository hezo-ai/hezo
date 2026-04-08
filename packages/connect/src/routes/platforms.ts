import { Hono } from 'hono';

const PLATFORMS = [
	{
		id: 'github',
		name: 'GitHub',
		scopes: ['repo', 'workflow', 'read:org'],
	},
	{
		id: 'anthropic',
		name: 'Anthropic',
		scopes: [],
	},
	{
		id: 'openai',
		name: 'OpenAI',
		scopes: ['openid', 'profile', 'email'],
	},
	{
		id: 'google',
		name: 'Google',
		scopes: ['openid', 'email', 'profile', 'generative-language'],
	},
] as const;

export const platformRoutes = new Hono();

platformRoutes.get('/platforms', (c) => c.json({ platforms: PLATFORMS }));

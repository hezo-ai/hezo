import { Hono } from 'hono';

const PLATFORMS = [
	{
		id: 'github',
		name: 'GitHub',
		scopes: ['repo', 'workflow', 'read:org'],
	},
] as const;

export const platformRoutes = new Hono();

platformRoutes.get('/platforms', (c) => c.json({ platforms: PLATFORMS }));

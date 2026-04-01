import { Hono } from 'hono';
import type { ConnectConfig } from '../config.js';

export function signingKeyRoutes(config: ConnectConfig): Hono {
	const routes = new Hono();

	routes.get('/signing-key', (c) => c.json({ key: config.statePublicKey }));

	return routes;
}

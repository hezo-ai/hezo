import { Hono } from 'hono';
import type { ConnectConfig } from './config.js';
import { NonceStore } from './crypto/state.js';
import { healthRoutes } from './routes/health.js';
import { platformRoutes } from './routes/platforms.js';
import { signingKeyRoutes } from './routes/signing-key.js';
import { oauthRoutes } from './routes/oauth.js';
import type { FetchFn } from './providers/github.js';

export function createApp(config: ConnectConfig, fetchFn?: FetchFn): Hono {
	const app = new Hono();
	const nonceStore = new NonceStore();

	app.route('/', healthRoutes);
	app.route('/', platformRoutes);
	app.route('/', signingKeyRoutes(config));
	app.route('/', oauthRoutes(config, nonceStore, fetchFn));

	return app;
}

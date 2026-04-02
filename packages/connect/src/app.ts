import { Hono } from 'hono';
import type { ConnectConfig } from './config.js';
import { NonceStore } from './crypto/state.js';
import { TokenCodeStore } from './crypto/token-store.js';
import type { FetchFn } from './providers/github.js';
import { healthRoutes } from './routes/health.js';
import { oauthRoutes } from './routes/oauth.js';
import { platformRoutes } from './routes/platforms.js';
import { signingKeyRoutes } from './routes/signing-key.js';

export function createApp(config: ConnectConfig, fetchFn?: FetchFn): Hono {
	const app = new Hono();
	const nonceStore = new NonceStore();
	const tokenCodeStore = new TokenCodeStore();

	app.route('/', healthRoutes);
	app.route('/', platformRoutes);
	app.route('/', signingKeyRoutes(config));
	app.route('/', oauthRoutes(config, nonceStore, tokenCodeStore, fetchFn));

	return app;
}

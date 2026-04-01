import { Hono } from 'hono';
import { healthRoutes } from './routes/health';

export function createApp(): Hono {
	const app = new Hono();
	app.route('/', healthRoutes);
	return app;
}

export const app = createApp();

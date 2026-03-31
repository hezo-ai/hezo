import { Hono } from 'hono';
import { healthRoutes } from './routes/health';

export const app = new Hono();

app.route('/', healthRoutes);

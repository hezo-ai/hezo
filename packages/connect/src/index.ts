import { app } from './app';

const port = parseInt(process.env.HEZO_CONNECT_PORT || '4100', 10);

console.log(`Hezo Connect starting on port ${port}...`);

export default {
	port,
	fetch: app.fetch,
};

import { app } from './app';
import { startup, type HezoConfig } from './startup';

const port = parseInt(process.env.PORT || '3100', 10);
const dataDir = process.env.HEZO_DATA_DIR || './data';
const connectUrl = process.env.HEZO_CONNECT_URL || 'https://connect.hezo.dev';
const reset = process.argv.includes('--reset');
const masterKey = process.env.HEZO_MASTER_KEY;

const config: HezoConfig = {
	port,
	dataDir,
	masterKey,
	connectUrl,
	reset,
};

let serveFetch = app.fetch;

startup(config)
	.then((result) => {
		serveFetch = result.app.fetch;
		console.log(`Hezo server running on port ${result.port} [${result.masterKeyState}]`);
	})
	.catch((err) => {
		console.error('Startup failed, serving minimal app:', err);
		console.log(`Hezo server (minimal) starting on port ${port}...`);
	});

export default {
	port,
	fetch: (req: Request, ...args: any[]) => serveFetch(req, ...args),
};

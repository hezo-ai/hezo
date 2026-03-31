import { app } from './app';
import { parseArgs } from './cli';
import { startup } from './startup';

const config = parseArgs();
let serveFetch = app.fetch;

startup(config)
	.then((result) => {
		serveFetch = result.app.fetch;
		const url = `http://localhost:${result.port}`;
		console.log(`Hezo server running at ${url} [${result.masterKeyState}]`);
		if (!config.noOpen) {
			Bun.spawn(["open", url]);
		}
	})
	.catch((err) => {
		console.error('Startup failed, serving minimal app:', err);
		console.log(`Hezo server (minimal) starting on port ${config.port}...`);
	});

export default {
	port: config.port,
	fetch: (req: Request, ...args: any[]) => serveFetch(req, ...args),
};

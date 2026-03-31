import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp(config);

console.log(`Hezo Connect starting on port ${config.port}...`);
if (config.github) {
	console.log('GitHub OAuth: configured');
} else {
	console.log('GitHub OAuth: not configured (set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET)');
}

export default {
	port: config.port,
	fetch: app.fetch,
};

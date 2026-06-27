import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { createLogger, defineConfig } from 'vite';

// Dev-server defaults are duplicated from @hezo/shared (DEFAULT_PORT /
// DEFAULT_WEB_PORT) rather than imported because vite-node cannot resolve the
// `.js`-style re-exports in @hezo/shared's TS-source entry point when loading
// the config.
const serverPort = process.env.HEZO_SERVER_PORT || '3100';
const webPort = Number(process.env.HEZO_WEB_PORT || '5173');
const serverUrl = `http://localhost:${serverPort}`;

const logger = createLogger();
const originalError = logger.error.bind(logger);
logger.error = (msg, options) => {
	if (msg.includes('ws proxy socket error')) return;
	originalError(msg, options);
};

// The same backend proxy table is used by the dev server (`vite`) and the
// preview server (`vite preview`, which serves the built bundle). The browser
// E2E suite runs against `preview` rather than `dev`: a minified, pre-bundled
// build is dramatically cheaper to serve than the dev server's per-request
// module transform, which kept the CI runner's CPU saturated and starved the
// backend until task fetches timed out. Keeping both tables identical means the
// proxied surface (REST, OAuth, MCP, the WebSocket upgrade) behaves the same in
// dev and in the E2E build.
const proxy = {
	'/api': serverUrl,
	'/oauth': serverUrl,
	'/health': serverUrl,
	'/mcp': serverUrl,
	'/SKILL.md': serverUrl,
	'/llms.txt': serverUrl,
	'/ws': {
		target: serverUrl.replace('http', 'ws'),
		ws: true,
	},
};

export default defineConfig({
	customLogger: logger,
	plugins: [TanStackRouterVite({ quoteStyle: 'single' }), react(), tailwindcss()],
	server: {
		port: webPort,
		proxy,
	},
	preview: {
		port: webPort,
		proxy,
	},
});

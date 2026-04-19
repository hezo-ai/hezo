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

export default defineConfig({
	customLogger: logger,
	plugins: [TanStackRouterVite({ quoteStyle: 'single' }), react(), tailwindcss()],
	server: {
		port: webPort,
		proxy: {
			'/api': serverUrl,
			'/oauth': serverUrl,
			'/health': serverUrl,
			'/mcp': serverUrl,
			'/skill.md': serverUrl,
			'/ws': {
				target: serverUrl.replace('http', 'ws'),
				ws: true,
			},
		},
	},
});

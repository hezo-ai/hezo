import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const serverPort = process.env.HEZO_SERVER_PORT || '3100';
const webPort = Number(process.env.HEZO_WEB_PORT || '5173');
const serverUrl = `http://localhost:${serverPort}`;

export default defineConfig({
	plugins: [TanStackRouterVite({ quoteStyle: 'single' }), react(), tailwindcss()],
	server: {
		port: webPort,
		proxy: {
			'/api': serverUrl,
			'/oauth': serverUrl,
			'/health': serverUrl,
		},
	},
});

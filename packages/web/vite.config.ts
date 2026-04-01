import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [TanStackRouterVite({ quoteStyle: 'single' }), react(), tailwindcss()],
	server: {
		port: 5173,
		proxy: {
			'/api': 'http://localhost:3100',
			'/oauth': 'http://localhost:3100',
			'/health': 'http://localhost:3100',
		},
	},
});

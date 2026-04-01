import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './e2e',
	timeout: 30000,
	retries: 0,
	use: {
		baseURL: 'http://localhost:5173',
		headless: true,
	},
	webServer: [
		{
			command: 'bun run --watch src/index.ts',
			cwd: '../server',
			port: 3100,
			reuseExistingServer: true,
		},
		{
			command: 'bun run dev',
			port: 5173,
			reuseExistingServer: true,
		},
	],
});

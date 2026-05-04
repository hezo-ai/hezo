import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const SERVER_PORT = 3101;
const WEB_PORT = 5174;
const TEST_DATA_DIR = join(tmpdir(), 'hezo-e2e-test');

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 180_000,
	retries: 1,
	workers: 2,
	fullyParallel: true,
	use: {
		baseURL: `http://localhost:${WEB_PORT}`,
		headless: true,
	},
	projects: [
		{
			name: 'ai-provider-serial',
			testMatch: /ai-providers\.spec\.ts$/,
			fullyParallel: false,
			workers: 1,
		},
		{
			name: 'parallel',
			testIgnore: /(?:ai-providers|\.mobile)\.spec\.ts$/,
			dependencies: ['ai-provider-serial'],
		},
		{
			name: 'mobile',
			testMatch: /\.mobile\.spec\.ts$/,
			use: { viewport: { width: 390, height: 844 } },
			dependencies: ['ai-provider-serial'],
		},
	],
	webServer: [
		{
			command: `bun run src/index.ts -- --port ${SERVER_PORT} --data-dir ${TEST_DATA_DIR} --master-key e2e-test-master-key-0123456789abcdef0123456789abcdef --reset`,
			cwd: './packages/server',
			// `Bun.serve` opens the port before `startup()` finishes registering
			// routes, so a port-only check races against route mounting and the
			// first /api/auth/token call sees Hono's default "404 Not Found".
			// /api/status is only mounted inside startup, so polling it waits
			// for full readiness.
			url: `http://localhost:${SERVER_PORT}/api/status`,
			reuseExistingServer: true,
			env: {
				SKIP_AI_KEY_VALIDATION: '1',
				HEZO_SKIP_DOCKER: '1',
				HEZO_WAKEUP_COALESCING_MS: '100',
			},
		},
		{
			command: 'bun run dev',
			cwd: './packages/web',
			port: WEB_PORT,
			reuseExistingServer: true,
			env: {
				HEZO_WEB_PORT: String(WEB_PORT),
				HEZO_SERVER_PORT: String(SERVER_PORT),
			},
		},
	],
});

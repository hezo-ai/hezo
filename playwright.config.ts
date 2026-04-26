import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const SERVER_PORT = 3101;
const CONNECT_PORT = 4101;
const WEB_PORT = 5174;
const TEST_DATA_DIR = join(tmpdir(), 'hezo-e2e-test');

const isCI = !!process.env.CI;
const reuseExistingServer = !isCI;

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 90_000,
	retries: isCI ? 1 : 0,
	workers: 6,
	fullyParallel: true,
	use: {
		baseURL: `http://localhost:${WEB_PORT}`,
		headless: true,
	},
	projects: [
		{
			name: 'ai-provider-serial',
			testMatch: /ai-providers?(-gate)?\.spec\.ts$/,
			fullyParallel: false,
			workers: 1,
		},
		{
			name: 'parallel',
			testIgnore: /ai-providers?(-gate)?\.spec\.ts$/,
			dependencies: ['ai-provider-serial'],
		},
	],
	webServer: [
		{
			command: `bun run src/index.ts -- --port ${SERVER_PORT} --data-dir ${TEST_DATA_DIR} --connect-url http://localhost:${CONNECT_PORT} --master-key e2e-test-master-key-0123456789abcdef0123456789abcdef --reset`,
			cwd: './packages/server',
			port: SERVER_PORT,
			reuseExistingServer,
			env: {
				SKIP_AI_KEY_VALIDATION: '1',
				HEZO_SKIP_DOCKER: '1',
				HEZO_WAKEUP_COALESCING_MS: '100',
			},
		},
		{
			command: 'bun run src/index.ts',
			cwd: './packages/connect',
			port: CONNECT_PORT,
			reuseExistingServer,
			env: {
				HEZO_CONNECT_PORT: String(CONNECT_PORT),
			},
		},
		{
			command: 'bun run dev',
			cwd: './packages/web',
			port: WEB_PORT,
			reuseExistingServer,
			env: {
				HEZO_WEB_PORT: String(WEB_PORT),
				HEZO_SERVER_PORT: String(SERVER_PORT),
			},
		},
	],
});

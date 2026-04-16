import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const SERVER_PORT = 3101;
const CONNECT_PORT = 4101;
const WEB_PORT = 5174;
const TEST_DATA_DIR = join(tmpdir(), 'hezo-e2e-test');

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 60_000,
	retries: process.env.CI ? 1 : 0,
	workers: 1,
	fullyParallel: false,
	use: {
		baseURL: `http://localhost:${WEB_PORT}`,
		headless: true,
	},
	webServer: [
		{
			command: `bun run --watch src/index.ts -- --port ${SERVER_PORT} --data-dir ${TEST_DATA_DIR} --connect-url http://localhost:${CONNECT_PORT} --master-key e2e-test-master-key-0123456789abcdef0123456789abcdef --reset --no-open`,
			cwd: './packages/server',
			port: SERVER_PORT,
			reuseExistingServer: true,
			env: {
				SKIP_AI_KEY_VALIDATION: '1',
				HEZO_SKIP_DOCKER: '1',
			},
		},
		{
			command: 'bun run --watch src/index.ts',
			cwd: './packages/connect',
			port: CONNECT_PORT,
			reuseExistingServer: true,
			env: {
				HEZO_CONNECT_PORT: String(CONNECT_PORT),
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

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { TEST_MNEMONIC } from './test/browser/constants';

const SERVER_PORT = 3101;
const WEB_PORT = 5174;
const TEST_DATA_DIR = join(tmpdir(), 'hezo-e2e-test');

// The master-key-gate spec owns its own backend lifecycle (boot, kill,
// restart on :3102), so it gets a dedicated vite instance proxying there —
// the shared server on :3101 must stay up for every other project.
const GATE_SERVER_PORT = 3102;
const GATE_WEB_PORT = 5175;

export default defineConfig({
	tsconfig: './tsconfig.json',
	testDir: './test/browser',
	timeout: 180_000,
	retries: 1,
	workers: 4,
	fullyParallel: true,
	// `list` prints one line per test as it finishes, so a mid-suite hang
	// is visible in CI logs immediately rather than hidden behind the
	// dot reporter's line-buffered batches. CI additionally emits an HTML
	// report so failed-run traces are browsable from the uploaded artifact.
	reporter: process.env.CI
		? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
		: 'list',
	use: {
		baseURL: `http://localhost:${WEB_PORT}`,
		headless: true,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
	},
	projects: [
		{
			name: 'ai-provider-serial',
			testMatch: /ai-providers\.spec\.ts$/,
			fullyParallel: false,
			workers: 1,
		},
		{
			name: 'agent-runs-serial',
			testMatch: /(?:agent-run-logs|run-trigger-reason)\.spec\.ts$/,
			fullyParallel: false,
			workers: 1,
			timeout: 300_000,
			dependencies: ['ai-provider-serial'],
		},
		{
			name: 'parallel',
			testIgnore:
				/(?:ai-providers|\.mobile|agent-run-logs|run-trigger-reason|master-key-gate)\.spec\.ts$/,
			// Run after agent-runs-serial so the shared e2e job queue is not flooded first.
			dependencies: ['ai-provider-serial', 'agent-runs-serial'],
		},
		{
			name: 'mobile',
			testMatch: /\.mobile\.spec\.ts$/,
			use: { viewport: { width: 390, height: 844 } },
			dependencies: ['ai-provider-serial'],
		},
		{
			// Self-contained: drives the pre-token setup wizard + locked gate
			// against its own server on :3102 (spawned by the spec itself).
			name: 'auth-gate',
			testMatch: /master-key-gate\.spec\.ts$/,
			fullyParallel: false,
			workers: 1,
			use: {
				baseURL: `http://localhost:${GATE_WEB_PORT}`,
				viewport: { width: 390, height: 844 },
			},
		},
	],
	webServer: [
		{
			command: `bun run src/index.ts -- --port ${SERVER_PORT} --data-dir ${TEST_DATA_DIR} --reset`,
			cwd: './packages/server',
			// `Bun.serve` opens the port before `startup()` finishes registering
			// routes, so a port-only check races against route mounting and the
			// first auth call sees Hono's default "404 Not Found". /api/status is
			// only mounted inside startup, so polling it waits for full readiness.
			url: `http://localhost:${SERVER_PORT}/api/status`,
			reuseExistingServer: false,
			env: {
				SKIP_AI_KEY_VALIDATION: '1',
				HEZO_SKIP_DOCKER: '1',
				// Boot-enrolls the master key (canary + auth public key) so tests
				// log in via the challenge dance instead of running setup. Env var
				// rather than a flag: a 12-word phrase is hostile to shell quoting.
				HEZO_MASTER_KEY: TEST_MNEMONIC,
				HEZO_WAKEUP_COALESCING_MS: '100',
				HEZO_WAKEUP_CRON: '* * * * * *',
				HEZO_HEARTBEAT_CRON: '* * * * * *',
				// Skip the team coherence-review enqueue path that Captain processes
				// on every team / agent-roster mutation. The review touches multiple
				// agents synthetically (~30-60s per team setup) and no e2e test asserts
				// on it. Turning it off keeps team-creation under 5s.
				HEZO_E2E_SKIP_COHERENCE_REVIEW: '1',
			},
		},
		{
			command: 'bun run dev',
			cwd: './packages/web',
			port: WEB_PORT,
			reuseExistingServer: false,
			env: {
				HEZO_WEB_PORT: String(WEB_PORT),
				HEZO_SERVER_PORT: String(SERVER_PORT),
			},
		},
		{
			command: 'bun run dev',
			cwd: './packages/web',
			port: GATE_WEB_PORT,
			reuseExistingServer: false,
			env: {
				HEZO_WEB_PORT: String(GATE_WEB_PORT),
				HEZO_SERVER_PORT: String(GATE_SERVER_PORT),
			},
		},
	],
});

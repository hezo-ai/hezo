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

// Serve the web frontend from the *built* bundle (`vite preview`) when the test
// runner sets HEZO_E2E_PREVIEW=1 (it builds the bundle first — see
// scripts/test.ts), otherwise fall back to the Vite dev server. The dev server
// transforms every module on demand; with two of them plus the backend, the 1Hz
// crons and four Chromium workers on a 2-core CI runner, that sustained CPU cost
// starved the backend until task fetches blew past the per-test timeouts and the
// suite flaked. The minified preview build is far cheaper to serve, so CI runs
// against it; a raw `bunx playwright test` (no runner, no prebuilt dist) still
// gets the dev server so one-off local debugging needs no build step.
const USE_PREVIEW = process.env.HEZO_E2E_PREVIEW === '1';
const webCommand = (port: number) =>
	USE_PREVIEW ? `bunx vite preview --port ${port} --strictPort` : 'bun run dev';

export default defineConfig({
	tsconfig: './tsconfig.json',
	testDir: './test/browser',
	timeout: 180_000,
	// CI runners are CPU-constrained, so a spec can lose a race to a cron tick or a
	// co-scheduled worker and time out on a slow page load — an environmental flake,
	// not a logic failure. Two retries (vs one) clears the residual tail without
	// masking real regressions: a genuinely broken test fails all three attempts.
	retries: process.env.CI ? 2 : 0,
	// Four Chromium workers on a 2-core CI runner oversubscribe the CPU and starve
	// the backend (see the preview-build note above) — the dominant source of the
	// page-load-timeout flakes that survive even retries. Match the workers to the
	// cores on CI; keep 4 locally where dev machines have the headroom.
	workers: process.env.CI ? 2 : 4,
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
				// Wakeups/heartbeats stay at 1Hz so agent-flow specs react promptly,
				// but container-status reconciliation has no sub-second consumer here
				// (fake docker sets status synchronously on create/start). Drop it from
				// 1Hz to every 10s so it stops compounding CPU load on the 2-core runner
				// — the largest cheap win against the page-load-timeout flakes.
				HEZO_CONTAINER_SYNC_CRON: '*/10 * * * * *',
				// Skip the team coherence-review enqueue path that Captain processes
				// on every team / agent-roster mutation. The review touches multiple
				// agents synthetically (~30-60s per team setup) and no e2e test asserts
				// on it. Turning it off keeps team-creation under 5s.
				HEZO_E2E_SKIP_COHERENCE_REVIEW: '1',
				// Pricing still seeds from the bundled snapshot (offline); skip the
				// boot-time refresh so e2e doesn't make an outbound feed fetch.
				HEZO_SKIP_PRICING_REFRESH: '1',
			},
		},
		{
			command: webCommand(WEB_PORT),
			cwd: './packages/web',
			port: WEB_PORT,
			reuseExistingServer: false,
			env: {
				HEZO_WEB_PORT: String(WEB_PORT),
				HEZO_SERVER_PORT: String(SERVER_PORT),
			},
		},
		{
			command: webCommand(GATE_WEB_PORT),
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

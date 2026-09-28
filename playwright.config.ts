import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import { TEST_MNEMONIC } from './test/browser/constants';

const SERVER_PORT = 3101;
const WEB_PORT = 5174;
const TEST_DATA_DIR = join(tmpdir(), 'hezo-e2e-test');
// Cron cadences and telemetry for the spawned server. Absolute because the
// server runs with cwd=packages/server, and passed as --config rather than env
// because these are operator settings, not test-only switches. Resolved from
// process.cwd() (Playwright is invoked from the repo root — AGENTS.md) rather
// than import.meta: Playwright loads this config through a CJS pipeline, and any
// `import.meta` in it flips the file to ESM, where the wrapper's `exports` is
// undefined and the whole config fails to load.
const E2E_CONFIG_FILE = resolve(process.cwd(), 'test/browser/hezo.e2e.config.cjs');

// The auth-gate specs own their own backend lifecycle (boot, kill,
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

// Playwright defaults each webServer to 60s, and — unlike a test — a webServer
// that misses its window is NOT covered by `retries`: the boot fails, the whole
// shard dies, and zero tests run. So the flake tolerance the rest of this file
// buys (two retries, halved workers, the preview build) stops exactly where the
// process starts, on the tightest budget in the config.
//
// Playwright starts the servers below one at a time, in array order, launching
// each only once the one before it answers, and each gets its own budget. So a
// shard that times out with no `[backend]` line never got past the first server,
// and the other two were never launched.
//
// The budget is not tight: 33 cold `--reset` boots of the backend on a dev box
// each answered /api/status in 1.1-2.2s, and on CI each preview answers a few
// seconds after launch. A cold runner several times slower than a laptop is a
// cold start that needs a budget, not a race to fix, so each server gets the
// 180s a test gets. When it is blown anyway, the timeout names no server: the
// `name` prefix on each server's output, and the `pw:webserver` trace CI turns
// on, say which one it was and what each readiness check got back.
const WEB_SERVER_TIMEOUT_MS = 180_000;

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
		// Full-page rather than the viewport-only default: the failures this tier
		// produces are geometry ones, and the element that moved the measurement is
		// routinely below the fold (a banner, a sticky footer, an overflowing list).
		// A viewport crop hides exactly the evidence the failure is about.
		screenshot: { mode: 'only-on-failure', fullPage: true },
		video: 'retain-on-failure',
		// The app registers a PWA service worker (packages/web/public/sw.js) on
		// localhost, which is a secure context — so without this it activates in the
		// E2E preview build too. A SW with a fetch handler re-issues requests from
		// inside the worker, and those bypass Playwright's `page.route()` mocks,
		// silently breaking every spec that stubs an API response (e.g.
		// mockRunComment in task-detail.mobile.spec.ts) the moment the SW wins its
		// activation race with page load. We never assert on the SW itself (the
		// install-prompt spec dispatches a synthetic `beforeinstallprompt`), so block
		// service workers in tests to keep route mocking deterministic.
		serviceWorkers: 'block',
		// Cloud/devcontainer images pre-install a Chromium at a fixed path that may
		// not match this Playwright version's expected browser revision. When set,
		// launch that binary instead of the revisioned download; unset (CI, local
		// dev) this is a no-op.
		launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
			? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
			: {},
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
				/(?:ai-providers|\.mobile|agent-run-logs|run-trigger-reason|master-key-gate|sso-gate)\.spec\.ts$/,
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
			testMatch: /(master-key-gate|sso-gate)\.spec\.ts$/,
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
			name: 'backend',
			command: `bun run src/index.ts -- --config ${E2E_CONFIG_FILE} --port ${SERVER_PORT} --data-dir ${TEST_DATA_DIR} --reset --no-open`,
			cwd: './packages/server',
			// Passes as soon as the port opens, not at full readiness: until
			// `startup()` finishes, the server answers /api/status 200 with
			// `starting: true` and every other /api route 503 STARTING. The login
			// helper (`requestSetupToken`) retries through those 503s, so the tests
			// wait out the rest of the boot there, and the web servers below boot
			// alongside the migrations instead of after them.
			url: `http://localhost:${SERVER_PORT}/api/status`,
			reuseExistingServer: false,
			timeout: WEB_SERVER_TIMEOUT_MS,
			// Playwright ignores a webServer's stdout by default and pipes only its
			// stderr, and Hezo's logger writes at INFO to stdout - so a boot that is
			// slow rather than broken would print *nothing*.
			//
			// Cheap, because the log is activity-gated rather than per-tick: the 1Hz
			// wakeup and heartbeat crons say nothing on a quiet tick, so this costs
			// the startup sequence and real work, not a line a second.
			stdout: 'pipe',
			env: {
				SKIP_AI_KEY_VALIDATION: '1',
				HEZO_SKIP_DOCKER: '1',
				// Boot-enrolls the master key (canary + auth public key) so tests
				// log in via the challenge dance instead of running setup. Env var
				// rather than a flag: a 12-word phrase is hostile to shell quoting.
				HEZO_MASTER_KEY: TEST_MNEMONIC,
				// Skip the team coherence-review enqueue path that Captain processes
				// on every team / agent-roster mutation. The review touches multiple
				// agents synthetically (~30-60s per team setup) and no e2e test asserts
				// on it. Turning it off keeps team-creation under 5s.
				HEZO_E2E_SKIP_COHERENCE_REVIEW: '1',
				// Skip the GitHub release check so e2e makes no outbound fetch, and
				// for a sharper reason: the release check decides
				// whether the UpdateBanner renders, and the banner sits between the app
				// header and the content row — so on a runner that can reach GitHub,
				// every element in the shell moves down by 47px (75px at mobile, where
				// the banner stacks) the moment a release newer than this tree ships.
				// That is a suite-wide layout change driven by a third party's release
				// schedule, and it took the browser tier red on the day 0.39.0 landed.
				HEZO_SKIP_UPDATE_CHECK: '1',
			},
		},
		{
			name: 'web',
			command: webCommand(WEB_PORT),
			cwd: './packages/web',
			port: WEB_PORT,
			reuseExistingServer: false,
			timeout: WEB_SERVER_TIMEOUT_MS,
			// Vite announces its listening URL on stdout; that line is what tells
			// "this preview came up" apart from "this preview never answered".
			stdout: 'pipe',
			env: {
				HEZO_WEB_PORT: String(WEB_PORT),
				HEZO_SERVER_PORT: String(SERVER_PORT),
			},
		},
		{
			name: 'gate-web',
			command: webCommand(GATE_WEB_PORT),
			cwd: './packages/web',
			port: GATE_WEB_PORT,
			reuseExistingServer: false,
			timeout: WEB_SERVER_TIMEOUT_MS,
			stdout: 'pipe',
			env: {
				HEZO_WEB_PORT: String(GATE_WEB_PORT),
				HEZO_SERVER_PORT: String(GATE_SERVER_PORT),
			},
		},
	],
});

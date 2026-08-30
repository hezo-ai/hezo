// Playwright-tier per AGENTS.md decision-tree item 6: this drives the
// master-key gate / instance setup flow before any token exists — the
// component harness always seeds an enrolled, unlocked server, so the unset
// wizard and the locked modal can only be exercised here. Runs in the
// dedicated `auth-gate` project against its own backend on :3102 (vite :5175).
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const GATE_SERVER_PORT = 3102;

test.describe.configure({ mode: 'serial' });

let server: ChildProcess | null = null;
let dataDir: string;

/**
 * Shape of `/api/status`. While the boot sequence runs, the pre-ready handler
 * answers 200 with `starting: true` and the current phase; once the real app is
 * serving, the payload carries `masterKeyState` instead.
 */
interface GateStatus {
	starting?: boolean;
	phase?: string;
	detail?: string;
	masterKeyState?: string;
}

async function fetchGateStatus(): Promise<GateStatus | null> {
	try {
		const res = await fetch(`http://localhost:${GATE_SERVER_PORT}/api/status`);
		if (!res.ok) return null;
		return (await res.json()) as GateStatus;
	} catch {
		return null; // Not listening yet.
	}
}

async function startGateServer(opts: { reset: boolean }): Promise<void> {
	// A previous attempt (a Playwright retry re-enters the test body without
	// running afterAll) may still hold the fixed port. Leaving it up would let the
	// readiness poll below succeed against the *stale* server while the newly
	// spawned one fails to bind, so every retry would assert against the wrong
	// instance's state.
	await stopGateServer();
	const args = [
		'run',
		'src/index.ts',
		'--',
		// Same config the playwright.config.ts webServer uses; telemetry off so
		// tests never phone home.
		'--config',
		resolve(process.cwd(), 'test/browser/hezo.e2e.config.cjs'),
		'--port',
		String(GATE_SERVER_PORT),
		'--data-dir',
		dataDir,
		// Suppress the desktop browser auto-open — it fires on local macOS/Windows
		// runs (CI/headless already skip it) and would pop a tab mid-test.
		'--no-open',
	];
	if (opts.reset) args.push('--reset');
	server = spawn('bun', args, {
		// Playwright is invoked from the repo root (AGENTS.md).
		cwd: resolve(process.cwd(), 'packages/server'),
		env: {
			...process.env,
			HEZO_SKIP_DOCKER: '1',
			SKIP_AI_KEY_VALIDATION: '1',
			// No boot key — the whole point is exercising the in-browser setup.
			// (Empty string reads as unset in the CLI's env resolution.)
			HEZO_MASTER_KEY: '',
			HEZO_SKIP_UPDATE_CHECK: '1',
		},
		stdio: 'ignore',
	});
	// A 200 from /api/status is NOT readiness: the pre-ready handler answers it
	// from the moment the socket accepts, while migrations, seeding and workspace
	// setup are still running and the SPA is showing a boot progress screen. Wait
	// for the real app's payload so the first assertion isn't racing the migration
	// replay a `--reset` start always performs.
	const deadline = Date.now() + 60_000;
	let lastPhase = 'unknown';
	while (Date.now() < deadline) {
		const status = await fetchGateStatus();
		if (status) {
			if (status.phase === 'error') {
				throw new Error(`master-key-gate server failed to start: ${status.detail ?? 'unknown'}`);
			}
			if (!status.starting && status.masterKeyState) return;
			lastPhase = status.phase ?? lastPhase;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(
		`master-key-gate server did not become ready on :${GATE_SERVER_PORT} (last phase: ${lastPhase})`,
	);
}

async function stopGateServer(): Promise<void> {
	const proc = server;
	server = null;
	if (!proc || proc.exitCode !== null) return;
	await new Promise<void>((done) => {
		const killTimer = setTimeout(() => proc.kill('SIGKILL'), 5_000);
		proc.once('exit', () => {
			clearTimeout(killTimer);
			done();
		});
		proc.kill('SIGTERM');
	});
}

test.beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), 'hezo-gate-e2e-'));
});

test.afterAll(async () => {
	await stopGateServer();
	rmSync(dataDir, { recursive: true, force: true });
});

const PASSWORD = 'e2e-admin-password';

test('setup → password → provider, then restart → unlock → password login', async ({ page }) => {
	await startGateServer({ reset: true });
	await page.goto('/');

	// Phase 0 — the language step comes BEFORE the master key on a fresh
	// instance: every screen after it is already product UI, so an operator who
	// cannot read English would otherwise meet their master key first. This
	// assertion is the ordering guarantee.
	await expect(page.getByTestId('setup-step-language')).toBeVisible();
	await expect(page.getByTestId('master-key-setup')).toHaveCount(0);
	await page.getByTestId('locale-save').click();

	// Phase A — unset: the pre-active vault setup screen at mobile viewport.
	await expect(page.getByTestId('master-key-setup')).toBeVisible();
	await page.getByRole('button', { name: /generate master key/i }).click();
	await expect(page.getByText('Encrypts your data and unlocks Hezo.')).toBeVisible();
	await expect(
		page.getByText(/New processes start locked by default.*one-shot --master-key/i),
	).toBeVisible();
	const words = page.getByTestId('mnemonic-word');
	await expect(words).toHaveCount(12);
	// The words are masked (password-style) by default — reveal them first.
	await page.getByRole('button', { name: /^show key$/i }).click();
	// Each item renders "<n> <word>" — strip the leading position number.
	const phrase = (await words.allTextContents())
		.map((t) => t.replace(/^\s*\d+\s*/, '').trim())
		.join(' ');
	// Continue only appears after copying the key, and stays disabled through a
	// short save countdown; clicking with an exact "Continue" name waits it out.
	await page.getByRole('button', { name: /copy to clipboard/i }).click();
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
	// Confirm step: paste the phrase back to prove it was captured, then commit.
	await page.getByLabel(/master key/i).fill(phrase);
	await page.getByRole('button', { name: /confirm key and continue/i }).click();

	// The unlock reveal plays, then the wizard advances to the dedicated
	// create-password step (the mnemonic only unlocked — no session yet).
	await expect(page.getByTestId('setup-step-password')).toBeVisible();
	await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
	await page.getByLabel('Confirm password').fill(PASSWORD);
	await page.getByRole('button', { name: /set password & continue/i }).click();

	// Setting the password mints a session; with no AI provider configured the
	// wizard resumes at the provider step.
	await expect(page.getByTestId('setup-step-ai-provider')).toBeVisible();
	const status = await page.request.get(`http://localhost:${GATE_SERVER_PORT}/api/status`);
	const statusBody = (await status.json()) as {
		masterKeyState: string;
		passwordSet: boolean;
		localeConfigured: boolean;
	};
	expect(statusBody.masterKeyState).toBe('unlocked');
	expect(statusBody.passwordSet).toBe(true);
	// The locale chosen in Phase 0 was persisted before the master key existed.
	expect(statusBody.localeConfigured).toBe(true);

	// Phase B — restart on the same data dir without a boot key: locked vault.
	await stopGateServer();
	await startGateServer({ reset: false });
	await page.reload();

	const entry = page.getByLabel(/master key/i);
	// The language step must NOT reappear: it is gated on the locale never
	// having been chosen, and the choice from Phase 0 is persisted in
	// system_meta - which is writable before the master key exists. A restarted
	// instance goes straight to the unlock screen.
	await expect(page.getByTestId('setup-step-language')).toHaveCount(0);
	await expect(page.getByTestId('master-key-unlock')).toBeVisible();

	// A valid-but-wrong phrase signs with the wrong keypair — server rejects.
	await entry.fill('legal winner thank year wave sausage worth useful legal winner thank yellow');
	await page.getByRole('button', { name: /unlock/i }).click();
	await expect(page.getByText(/signature verification failed/i)).toBeVisible();

	// The captured phrase unlocks. The instance is active but this browser has no
	// session, so the password login is next — the mnemonic never grants a session.
	await entry.fill(phrase);
	await page.getByRole('button', { name: /unlock/i }).click();
	await expect(page.getByTestId('password-login')).toBeVisible();

	// Sign in with the password set in Phase A → the app (provider step) returns.
	await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
	await page.getByRole('button', { name: /sign in/i }).click();
	await expect(page.getByTestId('setup-step-ai-provider')).toBeVisible();
});

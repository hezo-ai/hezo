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

async function startGateServer(opts: { reset: boolean }): Promise<void> {
	const args = [
		'run',
		'src/index.ts',
		'--',
		'--port',
		String(GATE_SERVER_PORT),
		'--data-dir',
		dataDir,
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
		},
		stdio: 'ignore',
	});
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://localhost:${GATE_SERVER_PORT}/api/status`);
			if (res.ok) return;
		} catch {
			// Not listening yet.
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error('master-key-gate server did not become ready on :3102');
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

test('first-boot setup wizard, then the locked gate after a restart', async ({ page }) => {
	await startGateServer({ reset: true });
	await page.goto('/');

	// Phase A — unset: the setup wizard's master-key step at mobile viewport.
	await expect(page.getByTestId('setup-step-master-key')).toBeVisible();
	await page.getByRole('button', { name: /generate key/i }).click();
	const words = page.getByTestId('mnemonic-word');
	await expect(words).toHaveCount(12);
	// Each item renders "<n> <word>" — strip the leading position number.
	const phrase = (await words.allTextContents())
		.map((t) => t.replace(/^\s*\d+\s*/, '').trim())
		.join(' ');
	await page.getByRole('button', { name: /set key & continue/i }).click();

	// Setup enrolled + unlocked the server; the wizard advances to the
	// AI-provider step (none configured on this fresh instance).
	await expect(page.getByTestId('setup-step-ai-provider')).toBeVisible();
	const status = await page.request.get(`http://localhost:${GATE_SERVER_PORT}/api/status`);
	expect(((await status.json()) as { masterKeyState: string }).masterKeyState).toBe('unlocked');

	// Phase B — restart on the same data dir without a boot key: locked gate.
	await stopGateServer();
	await startGateServer({ reset: false });
	await page.reload();

	const entry = page.getByLabel(/master key/i);
	await expect(entry).toBeVisible();

	// A valid-but-wrong phrase signs with the wrong keypair — server rejects.
	await entry.fill('legal winner thank year wave sausage worth useful legal winner thank yellow');
	await page.getByRole('button', { name: /unlock/i }).click();
	await expect(page.getByText(/signature verification failed/i)).toBeVisible();

	// The phrase captured during setup unlocks; with no AI provider configured
	// the wizard resumes at the provider step — the post-gate surface.
	await entry.fill(phrase);
	await page.getByRole('button', { name: /unlock/i }).click();
	await expect(page.getByTestId('setup-step-ai-provider')).toBeVisible();
	const after = await page.request.get(`http://localhost:${GATE_SERVER_PORT}/api/status`);
	expect(((await after.json()) as { masterKeyState: string }).masterKeyState).toBe('unlocked');
});

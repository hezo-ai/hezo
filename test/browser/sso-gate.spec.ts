// Playwright-tier per AGENTS.md decision-tree item 6: this drives the pre-auth
// gate, before any token exists, and it is the only tier that can. The component
// harness always seeds an unlocked, enrolled server, so the one journey that
// matters here - a token arriving at a LOCKED instance, surviving the passphrase
// prompt, and becoming a session afterwards - can only be exercised against a
// real server that is actually locked, in a real browser with a real address bar.
//
// Runs in the `auth-gate` project, serially, on the same backend port as the
// master-key gate spec.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	buildSsoTokenMessage,
	deriveAuthKeyPair,
	encodeSsoToken,
	generateMnemonic,
	type SsoTokenPayload,
	signAuthMessage,
} from '@hezo/shared';
import { expect, test } from '@playwright/test';

const GATE_SERVER_PORT = 3102;
const ISSUER_URL = 'https://control.example';
const OWNER = '9f1cb2d4-0000-4000-8000-000000000001';
const AUDIENCE = `localhost:${GATE_SERVER_PORT}`;

test.describe.configure({ mode: 'serial' });

const ISSUER = deriveAuthKeyPair(generateMnemonic());
const MNEMONIC = generateMnemonic();

let server: ChildProcess | null = null;
let dataDir: string;
let configPath: string;
let jti = 0;

function mintToken(overrides: Partial<SsoTokenPayload> = {}): string {
	const iat = Math.floor(Date.now() / 1000);
	const payload: SsoTokenPayload = {
		kid: 'k1',
		aud: AUDIENCE,
		sub: OWNER,
		jti: `e2e-${jti++}`,
		iat,
		exp: iat + 60,
		...overrides,
	};
	return encodeSsoToken(payload, signAuthMessage(ISSUER.privateKey, buildSsoTokenMessage(payload)));
}

async function fetchStatus(): Promise<{ starting?: boolean; masterKeyState?: string } | null> {
	try {
		const res = await fetch(`http://localhost:${GATE_SERVER_PORT}/api/status`);
		return res.ok ? ((await res.json()) as { starting?: boolean; masterKeyState?: string }) : null;
	} catch {
		return null; // Not listening yet.
	}
}

/**
 * Boot the instance. `enrol` supplies the passphrase on the command line so the
 * database comes up enrolled and unlocked; leaving it off is what produces the
 * locked instance this spec is really about.
 */
async function startServer(opts: { reset: boolean; enrol: boolean }): Promise<void> {
	await stopServer();
	const args = [
		'run',
		'src/index.ts',
		'--',
		'--config',
		configPath,
		'--port',
		String(GATE_SERVER_PORT),
		'--data-dir',
		dataDir,
		'--no-open',
	];
	if (opts.reset) args.push('--reset');
	server = spawn('bun', args, {
		cwd: resolve(process.cwd(), 'packages/server'),
		env: {
			...process.env,
			HEZO_SKIP_DOCKER: '1',
			SKIP_AI_KEY_VALIDATION: '1',
			HEZO_SKIP_UPDATE_CHECK: '1',
			HEZO_MASTER_KEY: opts.enrol ? MNEMONIC : '',
		},
		stdio: 'ignore',
	});

	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const status = await fetchStatus();
		if (status && !status.starting && status.masterKeyState) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`sso-gate server did not become ready on :${GATE_SERVER_PORT}`);
}

async function stopServer(): Promise<void> {
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
	dataDir = mkdtempSync(join(tmpdir(), 'hezo-sso-e2e-'));
	configPath = join(dataDir, 'hezo.sso.config.cjs');
	writeFileSync(
		configPath,
		`module.exports = ${JSON.stringify(
			{
				telemetry: { enabled: false },
				jobs: { containerSyncCron: '*/10 * * * * *' },
				sso: {
					issuerUrl: ISSUER_URL,
					logoutUrl: `${ISSUER_URL}/logout`,
					issuerPublicKey: `k1:${ISSUER.publicKeyHex}`,
					ownerSubject: OWNER,
					audience: AUDIENCE,
				},
			},
			null,
			2,
		)};\n`,
	);
});

test.afterAll(async () => {
	await stopServer();
	rmSync(dataDir, { recursive: true, force: true });
});

/** Stub the issuer so a redirect out lands somewhere assertable. */
async function stubIssuer(page: import('@playwright/test').Page): Promise<void> {
	await page.route(`${ISSUER_URL}/**`, (route) =>
		route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>issuer</h1>' }),
	);
}

test('an unidentified visitor is handed to the issuer, not asked for a password', async ({
	page,
}) => {
	await startServer({ reset: true, enrol: true });
	await stubIssuer(page);
	await page.goto('/');

	// No sign-in of its own, and no password fallback: signing in belongs to the
	// issuer, and this instance never enrols a password to fall back to.
	await expect(page).toHaveURL(/^https:\/\/control\.example/);
	await expect(page.getByTestId('password-login')).toHaveCount(0);
});

test('a token at a LOCKED instance survives the passphrase and becomes a session', async ({
	page,
}) => {
	// Locked is the normal state after any restart: the passphrase lives only in
	// the operator's head, so it is not on this command line.
	await startServer({ reset: false, enrol: false });
	await stubIssuer(page);

	await page.goto(`/#sso=${mintToken()}`);

	// Still locked, and still asking. A valid token identifies; it never unlocks.
	await expect(page.getByTestId('master-key-unlock')).toBeVisible();

	// The token is out of the address bar before anything else happens, so a
	// copied URL or a back-navigation cannot carry it.
	await expect.poll(() => new URL(page.url()).hash).toBe('');

	await page.getByRole('textbox').first().fill(MNEMONIC);
	await page.getByRole('button', { name: /unlock/i }).click();

	// The parked identity is redeemed for a session, so the visitor lands inside
	// without ever being asked for a password.
	await expect(page.getByTestId('master-key-unlock')).toHaveCount(0, { timeout: 30_000 });
	await expect(page.getByTestId('password-login')).toHaveCount(0);
	await expect(page).toHaveURL(/localhost/);
});

test('a rejected token stops rather than bouncing back to the issuer', async ({ page }) => {
	await startServer({ reset: false, enrol: true });
	await stubIssuer(page);

	await page.goto(`/#sso=${mintToken({ sub: 'somebody-else' })}`);

	await expect(page.getByTestId('sso-redirect')).toBeVisible();
	await expect(page).toHaveURL(/localhost/);
});

// First run: the control plane sends a new signup straight here, but there is no
// account to be anybody yet. The token is spent and useless - and would expire
// long before a phrase is written down - so arriving early must read as early,
// not as a failure that strands the visitor on an error screen. Only this tier
// has an instance that is genuinely unset.
test('a token arriving before setup shows the setup screen, not an error', async ({ page }) => {
	await startServer({ reset: true, enrol: false });
	await stubIssuer(page);

	await page.goto(`/#sso=${mintToken()}`);

	// The ordinary first-run journey, unchanged: language, then the master key.
	await expect(page.getByTestId('setup-step-language')).toBeVisible();
	await expect(page.getByTestId('sso-redirect')).toHaveCount(0);
	await expect(page.getByText(/did not complete/i)).toHaveCount(0);
});

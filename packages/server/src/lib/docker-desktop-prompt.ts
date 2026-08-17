import { logger } from '../logger';
import { SANDBOX_RATIONALE } from '../services/docker-preflight';
import { openBrowser } from './open-browser';

const log = logger.child('docker-desktop-prompt');

/**
 * Docker Desktop's Microsoft Store product id, from
 * https://apps.microsoft.com/detail/xp8cbj40xlbwkx.
 */
export const DOCKER_DESKTOP_STORE_PRODUCT_ID = 'XP8CBJ40XLBWKX';

/**
 * Store deep link. `ms-windows-store://pdp/` opens the product page inside the
 * Store app itself rather than a browser tab, which is where the install button
 * the operator needs actually lives.
 */
export const DOCKER_DESKTOP_STORE_URL = `ms-windows-store://pdp/?productid=${DOCKER_DESKTOP_STORE_PRODUCT_ID}`;

/** Browser-reachable form of the same listing, logged so the link survives the dialog. */
export const DOCKER_DESKTOP_STORE_WEB_URL = `https://apps.microsoft.com/detail/${DOCKER_DESKTOP_STORE_PRODUCT_ID.toLowerCase()}`;

export const DOCKER_DESKTOP_DIALOG_TITLE = 'Hezo needs Docker Desktop';

/**
 * Dialog body, one array element per line: what is missing, **why** it is
 * required, and what clicking OK will do.
 *
 * The middle part is the whole reason this is a dialog and not a silent exit.
 * "Install Docker" alone reads as an arbitrary dependency the operator is being
 * made to satisfy, and the honest answer is a security one - the container is
 * the boundary that stops an agent reaching the rest of their system. It is
 * `SANDBOX_RATIONALE` verbatim, the same answer the console guidance gives.
 *
 * The last part is consent: OK opens a Store page for them, so the dialog says
 * so before it happens.
 *
 * Hyphens only, never em/en dashes (user-facing prose rule).
 */
export const DOCKER_DESKTOP_DIALOG_BODY = [
	'Hezo cannot start: it needs Docker Desktop, and no container runtime is',
	'installed on this machine.',
	'',
	...SANDBOX_RATIONALE,
	'',
	'Click OK to open Docker Desktop in the Microsoft Store. Install it, start it,',
	'then run Hezo again.',
];

/**
 * How long to wait for the dialog before giving up and exiting anyway.
 *
 * The wait is the point - it holds the process open so the message stays on
 * screen - but it must still be bounded. Nothing in `browserAvailable` proves a
 * human is present (a Windows service account passes every one of its checks),
 * and an unbounded wait there is an invisible hang with no output at all.
 */
const DIALOG_TIMEOUT_MS = 120_000;

export interface DockerDesktopPromptInput {
	platform: NodeJS.Platform;
	/** `config.open` - cleared by `--no-open` / `HEZO_OPEN=0`. */
	autoOpenEnabled: boolean;
	/** `browserAvailable(...).available` - the same desktop-session test. */
	desktopSession: boolean;
}

export interface DockerDesktopPromptDecision {
	prompt: boolean;
	/** Human-readable reason the prompt was skipped. */
	reason?: string;
}

/**
 * Whether to interrupt the fatal exit with a dialog.
 *
 * Windows only, and deliberately so: this exists because of how the binary is
 * launched there. Double-clicked from Explorer it owns its console window, which
 * closes with the process, so the install guidance is printed to a window that
 * disappears before it can be read. On macOS and Linux the binary is run from a
 * shell that outlives it and the printed message is already the right answer.
 *
 * Pure and deterministic given its input, so the rule is testable off Windows.
 */
export function shouldPromptDockerDesktopInstall(
	input: DockerDesktopPromptInput,
): DockerDesktopPromptDecision {
	if (input.platform !== 'win32') {
		return { prompt: false, reason: 'not Windows' };
	}
	if (!input.autoOpenEnabled) {
		return { prompt: false, reason: 'auto-open disabled' };
	}
	if (!input.desktopSession) {
		return { prompt: false, reason: 'no desktop session' };
	}
	return { prompt: true };
}

/**
 * Escape a string for a PowerShell single-quoted literal, where the only
 * metacharacter is the quote itself and it is escaped by doubling. Our dialog
 * copy contains apostrophes, so this is load-bearing rather than defensive: an
 * unescaped one ends the literal and the whole command fails to parse.
 */
export function powerShellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The command that shows the dialog: Windows PowerShell (5.1, present on every
 * supported Windows) driving a WinForms message box, which needs no dependency
 * of ours and no window of our own.
 *
 * Exit code carries the answer - 0 for OK, 1 for Cancel or a dismissed dialog -
 * because that is the only channel back that survives `stdio: ignore`. Lines are
 * joined in PowerShell rather than embedded raw, so the whole script stays a
 * single-line argument.
 *
 * Pure so the quoting can be unit-tested without a Windows host.
 */
export function dockerDesktopDialogCommand(
	title = DOCKER_DESKTOP_DIALOG_TITLE,
	body = DOCKER_DESKTOP_DIALOG_BODY,
): string[] {
	const lines = body.map(powerShellSingleQuote).join(',');
	const script = [
		'Add-Type -AssemblyName System.Windows.Forms',
		`$m = @(${lines}) -join [Environment]::NewLine`,
		`$r = [System.Windows.Forms.MessageBox]::Show($m, ${powerShellSingleQuote(title)}, 'OKCancel', 'Warning')`,
		"if ($r -eq 'OK') { exit 0 }",
		'exit 1',
	].join('; ');
	return ['powershell.exe', '-NoProfile', '-Command', script];
}

/** What the prompt did, so the caller (and tests) can tell the paths apart. */
export type DockerDesktopPromptOutcome =
	| 'skipped'
	| 'store-opened'
	| 'declined'
	| 'dialog-failed'
	| 'timed-out';

/**
 * Tell the operator Docker Desktop is missing and, with their consent, open its
 * Microsoft Store listing.
 *
 * Called from the fatal-exit path only, and awaited: the exit is what makes the
 * printed guidance unreadable in the first place, so the dialog has to hold the
 * process open until it is dismissed. Best-effort throughout - a launcher that
 * is missing or refuses to start must not replace the operator's real error with
 * one of ours, so every failure logs and returns.
 */
export async function promptDockerDesktopInstall(
	input: DockerDesktopPromptInput,
): Promise<DockerDesktopPromptOutcome> {
	const decision = shouldPromptDockerDesktopInstall(input);
	if (!decision.prompt) return 'skipped';

	let accepted: boolean;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const proc = Bun.spawn(dockerDesktopDialogCommand(), {
			stdio: ['ignore', 'ignore', 'ignore'],
		});
		const timeout = new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), DIALOG_TIMEOUT_MS);
		});
		const result = await Promise.race([proc.exited, timeout]);
		if (result === 'timeout') {
			proc.kill();
			log.warn(
				`No answer to the Docker Desktop dialog after ${DIALOG_TIMEOUT_MS / 1000}s. ` +
					`Install it from ${DOCKER_DESKTOP_STORE_WEB_URL}`,
			);
			return 'timed-out';
		}
		accepted = result === 0;
	} catch (err) {
		log.warn('Could not show the Docker Desktop dialog:', err);
		return 'dialog-failed';
	} finally {
		// The caller exits immediately after this, but a live 2-minute timer would
		// hold the loop open for anyone who does not.
		if (timer) clearTimeout(timer);
	}

	if (!accepted) return 'declined';
	// Same platform launcher the web app uses; `start` hands a protocol URL to its
	// registered handler, which for `ms-windows-store://` is the Store app.
	log.info(`Opening Docker Desktop in the Microsoft Store (${DOCKER_DESKTOP_STORE_WEB_URL})`);
	openBrowser(DOCKER_DESKTOP_STORE_URL);
	return 'store-opened';
}

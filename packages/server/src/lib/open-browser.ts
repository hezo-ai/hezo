import { logger } from '../logger';

const log = logger.child('open-browser');

export interface BrowserAvailabilityInput {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	/** True when `/.dockerenv` exists — a strong signal we're inside a container. */
	hasDockerEnv: boolean;
}

export interface BrowserAvailability {
	available: boolean;
	/** Human-readable reason why a browser can't/shouldn't be opened. */
	reason?: string;
}

/**
 * Decide whether it's sensible to auto-open a browser in the current
 * environment. Pure and deterministic given its input so it can be unit-tested
 * across platforms without touching the host. The caller is responsible for
 * gathering the inputs (process.platform, process.env, /.dockerenv existence).
 *
 * Returns unavailable for the environments where a GUI browser either doesn't
 * exist or opening one would be wrong: CI, containers, SSH sessions, and
 * headless Linux (no X/Wayland display). Desktop macOS and Windows are assumed
 * to have a browser.
 */
export function browserAvailable(input: BrowserAvailabilityInput): BrowserAvailability {
	const { platform, env, hasDockerEnv } = input;

	if (env.CI) {
		return { available: false, reason: 'running in CI' };
	}
	if (hasDockerEnv || env.container) {
		return { available: false, reason: 'running in a container' };
	}
	if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) {
		return { available: false, reason: 'running over SSH' };
	}
	// Linux without an X11 or Wayland display has no GUI to open into. macOS and
	// Windows always have a windowing system available to a desktop session.
	if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
		return { available: false, reason: 'no display detected' };
	}
	return { available: true };
}

/**
 * The platform-appropriate launcher command for opening `url` in the default
 * browser: `open` on macOS, `start` (via cmd) on Windows, `xdg-open` elsewhere.
 * Pure so the mapping can be unit-tested without spawning a process.
 */
export function browserOpenCommand(platform: NodeJS.Platform, url: string): string[] {
	if (platform === 'darwin') return ['open', url];
	if (platform === 'win32') return ['cmd', '/c', 'start', '""', url];
	return ['xdg-open', url];
}

/**
 * Open `url` in the user's default browser. Fire-and-forget and best-effort:
 * never throws — a failure to launch must not take down the server. Callers
 * should gate this with {@link browserAvailable}.
 */
export function openBrowser(url: string): void {
	const cmd = browserOpenCommand(process.platform, url);
	try {
		Bun.spawn(cmd, { stdio: ['ignore', 'ignore', 'ignore'] });
	} catch (err) {
		log.warn(`Failed to open browser at ${url}:`, err);
	}
}

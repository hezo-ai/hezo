import { describe, expect, it } from 'vitest';
import {
	DOCKER_DESKTOP_DIALOG_BODY,
	DOCKER_DESKTOP_DIALOG_TITLE,
	DOCKER_DESKTOP_STORE_PRODUCT_ID,
	DOCKER_DESKTOP_STORE_URL,
	DOCKER_DESKTOP_STORE_WEB_URL,
	type DockerDesktopPromptInput,
	dockerDesktopDialogCommand,
	powerShellSingleQuote,
	shouldPromptDockerDesktopInstall,
} from '../src/lib/docker-desktop-prompt';
import { browserOpenCommand } from '../src/lib/open-browser';
import { DockerNotInstalledError, SandboxBackendError } from '../src/services/sandbox/errors';

const base: DockerDesktopPromptInput = {
	platform: 'win32',
	autoOpenEnabled: true,
	desktopSession: true,
};

describe('shouldPromptDockerDesktopInstall', () => {
	it('prompts on a Windows desktop session, where the console window closes with the process', () => {
		expect(shouldPromptDockerDesktopInstall(base).prompt).toBe(true);
	});

	it('stays off every other platform, whose console outlives the exit', () => {
		for (const platform of ['darwin', 'linux'] as const) {
			const decision = shouldPromptDockerDesktopInstall({ ...base, platform });
			expect(decision.prompt).toBe(false);
			expect(decision.reason).toMatch(/Windows/);
		}
	});

	it('honours --no-open / HEZO_OPEN=0', () => {
		const decision = shouldPromptDockerDesktopInstall({ ...base, autoOpenEnabled: false });
		expect(decision.prompt).toBe(false);
		expect(decision.reason).toMatch(/auto-open/);
	});

	it('never blocks a headless boot on a dialog nobody can answer', () => {
		const decision = shouldPromptDockerDesktopInstall({ ...base, desktopSession: false });
		expect(decision.prompt).toBe(false);
		expect(decision.reason).toMatch(/desktop/);
	});
});

describe('powerShellSingleQuote', () => {
	it('wraps in single quotes', () => {
		expect(powerShellSingleQuote('hello')).toBe("'hello'");
	});

	it("doubles embedded quotes, so an apostrophe can't terminate the literal", () => {
		expect(powerShellSingleQuote("each project's agents")).toBe("'each project''s agents'");
	});
});

describe('dockerDesktopDialogCommand', () => {
	const cmd = dockerDesktopDialogCommand();
	const script = cmd[3] ?? '';

	it('drives a WinForms message box through Windows PowerShell', () => {
		expect(cmd.slice(0, 3)).toEqual(['powershell.exe', '-NoProfile', '-Command']);
		expect(script).toContain('Add-Type -AssemblyName System.Windows.Forms');
		expect(script).toContain('[System.Windows.Forms.MessageBox]::Show');
		expect(script).toContain("'OKCancel'");
	});

	it('stays a single-line argument, joining the body inside PowerShell', () => {
		expect(script).not.toContain('\n');
		expect(script).toContain('-join [Environment]::NewLine');
	});

	it('reports the answer through the exit code, the only channel that survives stdio ignore', () => {
		expect(script).toContain("if ($r -eq 'OK') { exit 0 }");
		expect(script).toContain('exit 1');
	});

	it('escapes apostrophes in the body rather than emitting a broken script', () => {
		const withQuote = dockerDesktopDialogCommand('T', ["it's here"])[3] ?? '';
		expect(withQuote).toContain("'it''s here'");
	});

	it('escapes the title too', () => {
		expect(dockerDesktopDialogCommand("Hezo's", [])[3] ?? '').toContain("'Hezo''s'");
	});
});

describe('the dialog copy', () => {
	const text = [DOCKER_DESKTOP_DIALOG_TITLE, ...DOCKER_DESKTOP_DIALOG_BODY].join('\n');

	it('says a container runtime is missing', () => {
		expect(text).toContain('Docker Desktop');
		expect(text).toContain('no container runtime is');
	});

	it('explains why it is required: isolation from the rest of the system', () => {
		expect(text).toContain('isolated OS containers');
		expect(text).toContain('security boundary');
		expect(text).toContain('the rest of your system');
		expect(text).toMatch(/files/);
		expect(text).toMatch(/credentials/);
	});

	it('says what OK will do before it happens', () => {
		expect(text).toContain('Click OK');
		expect(text).toContain('Microsoft Store');
	});

	it('uses hyphens, never em or en dashes (user-facing prose rule)', () => {
		expect(text).not.toMatch(/[–—]/);
	});

	it('never leaks the test-only HEZO_SKIP_DOCKER escape hatch to users', () => {
		expect(text).not.toContain('HEZO_SKIP_DOCKER');
	});
});

describe('the Microsoft Store links', () => {
	it('deep-links the Store app at Docker Desktop, by product id', () => {
		expect(DOCKER_DESKTOP_STORE_PRODUCT_ID).toBe('XP8CBJ40XLBWKX');
		expect(DOCKER_DESKTOP_STORE_URL).toBe('ms-windows-store://pdp/?productid=XP8CBJ40XLBWKX');
	});

	it('carries a browser-reachable form of the same listing for the log', () => {
		expect(DOCKER_DESKTOP_STORE_WEB_URL).toBe('https://apps.microsoft.com/detail/xp8cbj40xlbwkx');
	});

	it('opens through the platform launcher, which hands the protocol URL to the Store app', () => {
		expect(browserOpenCommand('win32', DOCKER_DESKTOP_STORE_URL)).toEqual([
			'cmd',
			'/c',
			'start',
			'""',
			DOCKER_DESKTOP_STORE_URL,
		]);
	});

	it('carries no ampersand, which cmd start would treat as a command separator', () => {
		expect(DOCKER_DESKTOP_STORE_URL).not.toContain('&');
	});
});

describe('DockerNotInstalledError', () => {
	it('is a SandboxBackendError, so every existing catch still treats it as fatal', () => {
		const err = new DockerNotInstalledError('nothing installed');
		expect(err).toBeInstanceOf(SandboxBackendError);
		expect(err.name).toBe('DockerNotInstalledError');
		expect(err.message).toBe('nothing installed');
	});
});

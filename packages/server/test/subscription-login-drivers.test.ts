import { AgentRuntime } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { parseOsc8Links, stripTerminalNoise } from '../src/services/sandbox/proc-scripts';
import { SUBSCRIPTION_LOGIN_DRIVERS } from '../src/services/subscription-login-drivers';

/**
 * The fixtures below are **recorded verbatim** from the real CLIs at the
 * versions an unpinned image build installs, captured with the streams
 * separated and no TTY (Codex) and under a PTY (Claude Code).
 *
 * They are the whole point of this file: a parser written against prose in a
 * vendor doc is a guess, and the failure mode of a wrong guess is a sign-in that
 * hangs with nothing to say. Replace a fixture only by re-recording it.
 */

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/** codex-cli 0.147.0, `codex login --device-auth`, stdout, no TTY. */
const CODEX_DEVICE_AUTH_STDOUT = [
	'',
	`Welcome to Codex [v${ESC}[90m0.147.0${ESC}[0m]`,
	`${ESC}[90mOpenAI's command-line coding agent${ESC}[0m`,
	'',
	'Follow these steps to sign in with ChatGPT using device code authorization:',
	'',
	'1. Open this link in your browser and sign in to your account',
	`   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m`,
	'',
	`2. Enter this one-time code ${ESC}[90m(expires in 15 minutes)${ESC}[0m`,
	`   ${ESC}[94mR314-OEASM${ESC}[0m`,
	'',
	`${ESC}[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.${ESC}[0m`,
	'',
].join('\n');

const CLAUDE_AUTHORIZE_URL =
	'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
	'&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
	'&scope=user%3Ainference&code_challenge=8GlbqwGcLfCjSZqd4YKPNlnkImyrVGhW4JyztmEYzKo' +
	'&code_challenge_method=S256&state=SaXNZH65yg7VK-VEbRRQHqkLeMLCqg9ylLXiQcLJ4_4';

/**
 * claude-code 2.1.232, `claude setup-token`, under a PTY.
 *
 * The visible link text is deliberately reproduced as the mangled fragments the
 * spinner redraw leaves behind - that mangling is exactly why the driver reads
 * the OSC 8 escape instead.
 */
const CLAUDE_SETUP_TOKEN_PTY = [
	`${ESC}[?25lWelcome to Claude Code v2.1.232`,
	`${ESC}[90m·${ESC}[0m Opening browser to sign in…`,
	'✢  ✶  ✻  ✽  ✻  ✶  ✢  ·',
	"Browser didn't open? Use the url below to sign in (c to copy)",
	`${ESC}]8;id=155gj3v;${CLAUDE_AUTHORIZE_URL}${ESC}\\https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88${ESC}]8;;${ESC}\\`,
	`${ESC}]8;id=155gj3v;${CLAUDE_AUTHORIZE_URL}${ESC}\\ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.co${ESC}]8;;${ESC}\\`,
	'Paste code here if prompted >',
].join('\r\n');

describe('terminal output parsing', () => {
	it('strips CSI colour runs but keeps the text between them', () => {
		const text = stripTerminalNoise(CODEX_DEVICE_AUTH_STDOUT);
		expect(text).toContain('https://auth.openai.com/codex/device');
		expect(text).toContain('R314-OEASM');
		expect(text).not.toContain(ESC);
		expect(text).not.toContain('[94m');
	});

	it('turns carriage returns into line breaks so a redrawn line stands alone', () => {
		expect(stripTerminalNoise('a\rb')).toBe('a\nb');
	});

	it('recovers an OSC 8 target whose visible text was redrawn into fragments', () => {
		expect(parseOsc8Links(CLAUDE_SETUP_TOKEN_PTY)[0]).toBe(CLAUDE_AUTHORIZE_URL);
	});

	it('accepts a BEL-terminated OSC 8 sequence as well as ESC-backslash', () => {
		expect(parseOsc8Links(`${ESC}]8;;https://example.com/x${BEL}text`)).toEqual([
			'https://example.com/x',
		]);
	});

	it('ignores an OSC 8 close sequence, which carries no target', () => {
		expect(parseOsc8Links(`${ESC}]8;;${ESC}\\`)).toEqual([]);
	});
});

describe('codex device-auth driver', () => {
	const driver = SUBSCRIPTION_LOGIN_DRIVERS[AgentRuntime.Codex];

	it('reads the verification URL and the one-time code from real output', () => {
		expect(driver?.parseChallenge(CODEX_DEVICE_AUTH_STDOUT)).toEqual({
			url: 'https://auth.openai.com/codex/device',
			userCode: 'R314-OEASM',
		});
	});

	it('withholds a half-painted challenge rather than sending the operator to an unusable page', () => {
		const upToUrl = CODEX_DEVICE_AUTH_STDOUT.split('2. Enter this one-time code')[0];
		expect(upToUrl).toContain('auth.openai.com');
		expect(driver?.parseChallenge(upToUrl)).toBeNull();
	});

	it('returns null on output that carries no challenge at all', () => {
		expect(driver?.parseChallenge('Welcome to Codex\n')).toBeNull();
	});

	it('needs nothing back from the operator and harvests the runtime auth file', () => {
		expect(driver?.completion).toBe('none');
		expect(driver?.harvest).toBe('auth-file');
	});

	it('probes for the beta flag it depends on', () => {
		expect(driver?.capabilityProbe?.mustContain).toBe('--device-auth');
	});
});

describe('claude setup-token driver', () => {
	const driver = SUBSCRIPTION_LOGIN_DRIVERS[AgentRuntime.ClaudeCode];

	it('reads the authorize URL out of the PTY redraw', () => {
		expect(driver?.parseChallenge(CLAUDE_SETUP_TOKEN_PTY)).toEqual({ url: CLAUDE_AUTHORIZE_URL });
	});

	it('offers no user code, because its callback page displays one instead', () => {
		expect(driver?.parseChallenge(CLAUDE_SETUP_TOKEN_PTY)?.userCode).toBeUndefined();
	});

	it('ignores a hyperlink that is not an authorize URL', () => {
		expect(driver?.parseChallenge(`${ESC}]8;;https://claude.com/docs${ESC}\\`)).toBeNull();
	});

	it('asks the operator for a code', () => {
		expect(driver?.completion).toBe('code');
	});

	it('harvests the oat token the CLI prints, not an API key', () => {
		const harvest = driver?.harvest;
		expect(typeof harvest).toBe('function');
		if (typeof harvest !== 'function') return;
		expect(harvest(`${ESC}[32mtoken:${ESC}[0m sk-ant-oat01-AbC123_x-Y\n`)).toBe(
			'sk-ant-oat01-AbC123_x-Y',
		);
		expect(harvest('sk-ant-api03-not-a-subscription-token')).toBeNull();
		expect(harvest('Paste code here if prompted >')).toBeNull();
	});
});

describe('driver coverage', () => {
	it('is exhaustive over every runtime, so a new CLI cannot be silently missed', () => {
		for (const runtime of Object.values(AgentRuntime)) {
			expect(SUBSCRIPTION_LOGIN_DRIVERS).toHaveProperty(runtime);
		}
	});

	it('leaves Gemini on manual paste deliberately, having no scriptable sign-in', () => {
		expect(SUBSCRIPTION_LOGIN_DRIVERS[AgentRuntime.Gemini]).toBeNull();
	});

	it('gives every driver a challenge timeout below its completion timeout', () => {
		for (const driver of Object.values(SUBSCRIPTION_LOGIN_DRIVERS)) {
			if (!driver) continue;
			expect(driver.challengeTimeoutMs).toBeGreaterThan(0);
			expect(driver.challengeTimeoutMs).toBeLessThan(driver.completionTimeoutMs);
		}
	});
});

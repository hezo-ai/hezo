import { AgentRuntime } from '@hezo/shared';
import { parseOsc8Links, stripTerminalNoise } from './sandbox/proc-scripts';

/**
 * How each coding CLI mints a subscription credential from an interactive
 * sign-in, and how Hezo reads what it printed.
 *
 * Keyed by RUNTIME, for the same reason `RUNTIME_HOME_LAYOUTS` is: the login
 * command, the shape of the challenge and whether the CLI wants anything back
 * are properties of the binary, not of the account. Pass the RESOLVED runtime
 * (`effectiveRuntime`), never the provider default.
 *
 * **Where the credential lands is not restated here.** A driver harvesting
 * `'auth-file'` reads `RUNTIME_HOME_LAYOUTS[runtime].authFileRelative` under the
 * flow's own home, and the CLI is pointed at that home with the same layout's
 * `envVarName` - so the path a login writes and the path a run reads can never
 * drift apart.
 */

/** What the operator must be shown to complete a sign-in. */
export interface LoginChallenge {
	/** The URL to open. Opened on whatever device the operator is holding. */
	url: string;
	/** A one-time code to type on the vendor's page, when the flow uses one. */
	userCode?: string;
}

export interface SubscriptionLoginDriver {
	/** argv, run under the PTY `buildSubscriptionLoginScript` allocates. */
	argv: readonly string[];
	/**
	 * Env beyond the runtime's own home var, which the caller always sets.
	 * Anything here is a property of the login, not of a run.
	 */
	extraEnv?: Readonly<Record<string, string>>;
	/**
	 * Proof the installed CLI still offers this flow, run before the operator is
	 * shown anything.
	 *
	 * The three coding CLIs are installed **unpinned** in the agent image, so a
	 * flag can vanish under a rebuild. Without this the loss would surface as a
	 * flow that hangs until its challenge timeout with nothing to say; with it,
	 * the start fails naming the CLI and the flag.
	 */
	capabilityProbe?: { argv: readonly string[]; mustContain: string };
	/** Recognise the challenge in the log so far. Null until the CLI has printed it. */
	parseChallenge(log: string): LoginChallenge | null;
	/**
	 * What the operator returns. `'none'` means the CLI polls the vendor itself
	 * and Hezo only waits - the sign-in never round-trips through Hezo at all.
	 */
	completion: 'none' | 'code';
	/**
	 * Where the credential ends up. `'auth-file'` reads the runtime's own
	 * `authFileRelative`; a function reads it out of what the CLI printed.
	 */
	harvest: 'auth-file' | ((log: string) => string | null);
	/** No challenge parsed by here means the output format moved. */
	challengeTimeoutMs: number;
	/** Matches the vendor's own expiry for the challenge. */
	completionTimeoutMs: number;
}

const MINUTE = 60_000;

/** First `https://` URL on a line of its own, ignoring anything inside prose. */
function firstStandaloneUrl(text: string, hostContains: string): string | null {
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('https://')) continue;
		if (!trimmed.includes(hostContains)) continue;
		const url = trimmed.split(/\s+/)[0];
		if (url.length > 0) return url;
	}
	return null;
}

/**
 * Codex, via its device-code flow.
 *
 * The only one of the three that needs no PTY and returns nothing to Hezo: the
 * CLI polls OpenAI itself and writes `auth.json` when the operator finishes on
 * their own device. Verified against codex-cli 0.147.0, which prints the URL and
 * code to stdout as their own lines:
 *
 *     1. Open this link in your browser and sign in to your account
 *        https://auth.openai.com/codex/device
 *
 *     2. Enter this one-time code (expires in 15 minutes)
 *        R314-OEASM
 *
 * `--device-auth` carries no description in `--help`, i.e. it is still beta -
 * hence the probe.
 */
const CODEX_DRIVER: SubscriptionLoginDriver = {
	argv: ['codex', 'login', '--device-auth'],
	capabilityProbe: { argv: ['codex', 'login', '--help'], mustContain: '--device-auth' },
	parseChallenge(log) {
		const text = stripTerminalNoise(log);
		const url = firstStandaloneUrl(text, 'auth.openai.com');
		if (!url) return null;
		// The code is printed alone on its line; matching that rather than
		// scanning the whole text keeps it from picking a fragment out of the URL.
		let userCode: string | undefined;
		for (const line of text.split('\n')) {
			const trimmed = line.trim();
			if (/^[A-Z0-9]{4}-[A-Z0-9]{4,8}$/.test(trimmed)) {
				userCode = trimmed;
				break;
			}
		}
		// Both halves or nothing: a URL without the code is an unfinished paint,
		// and showing it would send the operator to a page they cannot complete.
		return userCode ? { url, userCode } : null;
	},
	completion: 'none',
	harvest: 'auth-file',
	challengeTimeoutMs: 2 * MINUTE,
	completionTimeoutMs: 15 * MINUTE,
};

/**
 * Claude Code, via `setup-token`.
 *
 * Needs a PTY: on a pipe it emits zero bytes and never exits. Its callback is
 * the hosted page `platform.claude.com/oauth/code/callback`, which displays a
 * code rather than redirecting to a loopback port - so nothing has to listen
 * anywhere and the operator simply brings the code back.
 *
 * The URL is read from the OSC 8 hyperlink rather than the visible text: the
 * spinner redraws around it, and the on-screen copy comes back interleaved
 * across several overlapping fragments while the escape stays whole.
 */
const CLAUDE_CODE_DRIVER: SubscriptionLoginDriver = {
	argv: ['claude', 'setup-token'],
	parseChallenge(log) {
		for (const link of parseOsc8Links(log)) {
			if (link.includes('/oauth/authorize')) return { url: link };
		}
		return null;
	},
	completion: 'code',
	harvest: (log) => stripTerminalNoise(log).match(/sk-ant-oat01-[A-Za-z0-9_-]+/)?.[0] ?? null,
	challengeTimeoutMs: 2 * MINUTE,
	completionTimeoutMs: 15 * MINUTE,
};

/**
 * Which runtimes can mint a credential from a guided sign-in, and which
 * deliberately cannot.
 *
 * Exhaustive over `AgentRuntime` so a new CLI is a compile error here rather
 * than a runtime that silently has no sign-in. `null` is a decision, not a gap:
 * the provider keeps the manual paste path, and the UI offers only that.
 */
export const SUBSCRIPTION_LOGIN_DRIVERS: Record<AgentRuntime, SubscriptionLoginDriver | null> = {
	[AgentRuntime.Codex]: CODEX_DRIVER,
	[AgentRuntime.ClaudeCode]: CLAUDE_CODE_DRIVER,
	/**
	 * Gemini has no non-interactive sign-in to drive.
	 *
	 * It exposes no auth flag, boots straight into a full-screen TUI that
	 * repaints continuously, and picks its auth method from a menu that only
	 * arrow keys and Enter reach - so a driver would be synthesising keystrokes
	 * against a redrawing screen, which breaks on any layout change. Google's own
	 * headless guidance is to use `GOOGLE_API_KEY` or a service account instead.
	 *
	 * Google subscriptions therefore stay on manual paste until the CLI offers a
	 * scriptable flow. Filling this in is one row, and nothing else changes.
	 */
	[AgentRuntime.Gemini]: null,
	// Api-key only - no subscription auth to mint (see AI_PROVIDER_INFO).
	[AgentRuntime.OpenCode]: null,
	[AgentRuntime.Grok]: null,
	[AgentRuntime.Kimi]: null,
};

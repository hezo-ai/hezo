import { AiProvider } from '@hezo/shared';
import type { ReactNode } from 'react';

interface ProviderInstructions {
	title: string;
	steps: ReactNode[];
	footer: ReactNode;
	placeholder: string;
}

export const SUBSCRIPTION_INSTRUCTIONS: Partial<Record<AiProvider, ProviderInstructions>> = {
	[AiProvider.Anthropic]: {
		title: 'How to get your Claude subscription token',
		steps: [
			<>
				Install Claude Code on your local machine:{' '}
				<code>npm install -g @anthropic-ai/claude-code</code>.
			</>,
			<>
				Run <code>claude setup-token</code> (requires a Claude Pro or Max subscription). A browser
				window opens — sign in with the Claude account whose subscription you want to use.
			</>,
			<>
				Copy the token it prints (it starts with <code>sk-ant-oat01-</code>) and paste it into the
				box below.
			</>,
		],
		footer: (
			<>
				This is a long-lived token (about a year). Hezo passes it as{' '}
				<code>CLAUDE_CODE_OAUTH_TOKEN</code> and never uses an API key for this provider. Revoke it
				anytime from your Anthropic account settings.
			</>
		),
		placeholder: 'sk-ant-oat01-...',
	},
	[AiProvider.OpenAI]: {
		title: 'How to get your Codex subscription auth file',
		steps: [
			<>
				Install the Codex CLI on your local machine: <code>npm install -g @openai/codex</code>.
			</>,
			<>
				Run <code>codex login</code>. A browser window will open at <code>auth.openai.com</code> —
				sign in with the ChatGPT account whose subscription you want to use.
			</>,
			<>
				Open <code>~/.codex/auth.json</code> (macOS/Linux) or{' '}
				<code>%USERPROFILE%\.codex\auth.json</code> (Windows).
			</>,
			<>Copy the entire contents of that file and paste them into the box below.</>,
		],
		footer: (
			<>
				Heads up: this credential auto-rotates each time Hezo runs Codex. Don't keep using the same
				login on your laptop afterwards — pick one or the other, otherwise the refresh token will
				desync. To stop, remove the credential here and re-run <code>codex login</code> locally.
			</>
		),
		placeholder: '{"tokens":{"refresh_token":"...","access_token":"...","id_token":"..."}}',
	},
	[AiProvider.Google]: {
		title: 'How to get your Gemini subscription auth file',
		steps: [
			<>
				Install the Gemini CLI on your local machine: <code>npm install -g @google/gemini-cli</code>
				.
			</>,
			<>
				Run <code>gemini</code> and choose <strong>Sign in with Google</strong>. A browser window
				will open — sign in with the Google account whose Gemini access you want to use.
			</>,
			<>
				Open <code>~/.gemini/oauth_creds.json</code> (macOS/Linux) or{' '}
				<code>%USERPROFILE%\.gemini\oauth_creds.json</code> (Windows). On newer Gemini CLI versions
				the credential may be stored in your OS keychain instead — sign out and back in with{' '}
				<code>GEMINI_FORCE_FILE_STORAGE=true</code> set to force a plaintext file.
			</>,
			<>Copy the entire contents of that file and paste them into the box below.</>,
		],
		footer: (
			<>
				The refresh token in <code>oauth_creds.json</code> is reusable across runs. If you revoke
				access in your Google account or sign out locally, re-paste a fresh file here.
			</>
		),
		placeholder:
			'{"access_token":"ya29....","refresh_token":"1//...","scope":"...","token_type":"Bearer","expiry_date":1234567890}',
	},
	[AiProvider.Kimi]: {
		title: 'How to get your Kimi subscription auth file',
		steps: [
			<>
				Install the Kimi Code CLI on your local machine:{' '}
				<code>npm install -g @moonshot-ai/kimi-code</code>.
			</>,
			<>
				Run <code>kimi login</code> and complete the device-code sign-in in your browser with the
				Kimi account whose subscription you want to use.
			</>,
			<>
				Open <code>~/.kimi-code/credentials/kimi-code.json</code> (macOS/Linux).
			</>,
			<>Copy the entire contents of that file and paste them into the box below.</>,
		],
		footer: (
			<>
				Heads up: this credential auto-rotates each time Hezo runs Kimi. Don't keep using the same
				login on your laptop afterwards — pick one or the other, otherwise the refresh token will
				desync. To stop, remove the credential here and re-run <code>kimi login</code> locally.
			</>
		),
		placeholder:
			'{"access_token":"...","refresh_token":"...","expires_at":1234567890000,"token_type":"Bearer"}',
	},
};

/** The gray, provider-specific "how to get your subscription credential" box. */
export function SubscriptionInstructions({ provider }: { provider: AiProvider }) {
	const instructions = SUBSCRIPTION_INSTRUCTIONS[provider];
	if (!instructions) return null;
	return (
		<div className="rounded-md border border-border bg-surface-2 p-3 text-[13px] text-text-2">
			<p className="font-medium text-text-1 mb-2">{instructions.title}</p>
			<ol className="list-decimal pl-5 space-y-1">
				{instructions.steps.map((step, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: instruction list is static
					<li key={i}>{step}</li>
				))}
			</ol>
			<p className="mt-2">{instructions.footer}</p>
		</div>
	);
}

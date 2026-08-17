import { AiProvider } from '@hezo/shared';
import { InstructionsBox, type ProviderInstructionContent } from './provider-instructions';

interface ProviderInstructions extends ProviderInstructionContent {
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
				window opens - sign in with the Claude account whose subscription you want to use.
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
				Run <code>codex login</code>. A browser window will open at <code>auth.openai.com</code> -
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
				login on your laptop afterwards - pick one or the other, otherwise the refresh token will
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
				will open - sign in with the Google account whose Gemini access you want to use.
			</>,
			<>
				Open <code>~/.gemini/oauth_creds.json</code> (macOS/Linux) or{' '}
				<code>%USERPROFILE%\.gemini\oauth_creds.json</code> (Windows). On newer Gemini CLI versions
				the credential may be stored in your OS keychain instead - sign out and back in with{' '}
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
};

/** The gray, provider-specific "how to get your subscription credential" box. */
export function SubscriptionInstructions({ provider }: { provider: AiProvider }) {
	const instructions = SUBSCRIPTION_INSTRUCTIONS[provider];
	if (!instructions) return null;
	return <InstructionsBox content={instructions} />;
}

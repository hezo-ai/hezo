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
				Paste the token <code>setup-token</code> printed, not the one inside{' '}
				<code>~/.claude/.credentials.json</code> - that one starts with the same characters but
				lasts hours, so it is accepted here and then fails every run. This one is long-lived (about
				a year). Hezo passes it as <code>CLAUDE_CODE_OAUTH_TOKEN</code> and never uses an API key
				for this provider. There is no refresh token behind it, so once it expires or you revoke it,
				sign in again to replace it.
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
	// Google is API-key only in Hezo for now: Antigravity has a consumer
	// subscription (Login with Google), but Hezo cannot yet deliver its
	// keyring-only OAuth into a run container, so there is no paste flow for it.
};

/** The gray, provider-specific "how to get your subscription credential" box. */
export function SubscriptionInstructions({ provider }: { provider: AiProvider }) {
	const instructions = SUBSCRIPTION_INSTRUCTIONS[provider];
	if (!instructions) return null;
	return <InstructionsBox content={instructions} />;
}

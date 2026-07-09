import { AiProvider } from '@hezo/shared';
import {
	InstructionsBox,
	InstructionsLink,
	type ProviderInstructionContent,
} from './provider-instructions';

/**
 * Per-provider "how to get an API key" walkthroughs, each linking to the
 * provider's own key console. Deliberately a full record (not Partial): adding
 * a provider without its key instructions should fail the typecheck.
 */
export const API_KEY_INSTRUCTIONS: Record<AiProvider, ProviderInstructionContent> = {
	[AiProvider.Anthropic]: {
		title: 'How to get your Anthropic API key',
		steps: [
			<>
				Sign in to the{' '}
				<InstructionsLink href="https://platform.claude.com/">Claude Console</InstructionsLink> (or
				create an account).
			</>,
			<>
				Open{' '}
				<InstructionsLink href="https://platform.claude.com/settings/keys">
					Settings → API keys
				</InstructionsLink>{' '}
				and click <strong>Create key</strong>.
			</>,
			<>
				Copy the key (starts with <code>sk-ant-</code>) and paste it below — it's only shown once.
			</>,
		],
		footer: (
			<>
				API usage is billed per token from prepaid credits — add credits under the Console's Billing
				settings. Have a Claude Pro or Max plan? Use the <strong>Claude Code subscription</strong>{' '}
				option above instead.
			</>
		),
	},
	[AiProvider.OpenAI]: {
		title: 'How to get your OpenAI API key',
		steps: [
			<>
				Sign in to the{' '}
				<InstructionsLink href="https://platform.openai.com/">OpenAI Platform</InstructionsLink> (or
				create an account).
			</>,
			<>
				Open the{' '}
				<InstructionsLink href="https://platform.openai.com/api-keys">API keys</InstructionsLink>{' '}
				page and click <strong>Create new secret key</strong>.
			</>,
			<>
				Copy the key (starts with <code>sk-</code>) and paste it below — it's only shown once.
			</>,
		],
		footer: (
			<>
				API usage is billed separately from ChatGPT — add a payment method under the platform's
				Billing settings. Have a ChatGPT Plus or Pro plan? Use the{' '}
				<strong>Codex subscription</strong> option above instead.
			</>
		),
	},
	[AiProvider.Google]: {
		title: 'How to get your Gemini API key',
		steps: [
			<>
				Open{' '}
				<InstructionsLink href="https://aistudio.google.com/apikey">
					Google AI Studio → API keys
				</InstructionsLink>{' '}
				and sign in with your Google account.
			</>,
			<>
				Click <strong>Create API key</strong> and pick (or create) the Google Cloud project the key
				should live in.
			</>,
			<>
				Copy the key (starts with <code>AIza</code>) and paste it below.
			</>,
		],
		footer: (
			<>
				AI Studio keys start on a free tier with strict rate limits — enable billing on the key's
				Google Cloud project for sustained agent use. Have a Google AI Pro/Ultra plan? Use the{' '}
				<strong>Gemini subscription</strong> option above instead.
			</>
		),
	},
	[AiProvider.DeepSeek]: {
		title: 'How to get your DeepSeek API key',
		steps: [
			<>
				Sign in to the{' '}
				<InstructionsLink href="https://platform.deepseek.com/">DeepSeek Platform</InstructionsLink>{' '}
				(or create an account).
			</>,
			<>
				Open{' '}
				<InstructionsLink href="https://platform.deepseek.com/api_keys">API keys</InstructionsLink>{' '}
				and click <strong>Create new API key</strong>.
			</>,
			<>Copy the key and paste it below — it's only shown once.</>,
		],
		footer: (
			<>The DeepSeek API is prepaid — top up your balance on the platform before agents run.</>
		),
	},
	[AiProvider.ZAi]: {
		title: 'How to get your Z.ai API key',
		steps: [
			<>
				Register or sign in on the{' '}
				<InstructionsLink href="https://z.ai/model-api">Z.ai API platform</InstructionsLink>.
			</>,
			<>
				Open the{' '}
				<InstructionsLink href="https://z.ai/manage-apikey/apikey-list">API keys</InstructionsLink>{' '}
				page and click <strong>Create a new API key</strong>.
			</>,
			<>Copy the key and paste it below.</>,
		],
		footer: (
			<>
				Usage is billed from your prepaid balance — top up on the{' '}
				<InstructionsLink href="https://z.ai/manage-apikey/billing">Billing</InstructionsLink> page
				if needed.
			</>
		),
	},
	[AiProvider.OpenRouter]: {
		title: 'How to get your OpenRouter API key',
		steps: [
			<>
				Sign in at <InstructionsLink href="https://openrouter.ai/">OpenRouter</InstructionsLink> (or
				create an account).
			</>,
			<>
				Open{' '}
				<InstructionsLink href="https://openrouter.ai/settings/keys">
					Settings → API keys
				</InstructionsLink>{' '}
				and click <strong>Create key</strong>.
			</>,
			<>
				Copy the key (starts with <code>sk-or-</code>) and paste it below — it's only shown once.
			</>,
		],
		footer: (
			<>
				One OpenRouter key routes to models from many labs. Usage is prepaid — buy credits in your
				OpenRouter account before agents run.
			</>
		),
	},
	[AiProvider.Kimi]: {
		title: 'How to get your Kimi API key',
		steps: [
			<>
				Sign in to the{' '}
				<InstructionsLink href="https://platform.kimi.ai/">Kimi Open Platform</InstructionsLink>{' '}
				(Moonshot AI's developer console).
			</>,
			<>
				Open{' '}
				<InstructionsLink href="https://platform.kimi.ai/console/api-keys">
					API keys
				</InstructionsLink>{' '}
				and click <strong>Create API key</strong>.
			</>,
			<>
				Copy the key (starts with <code>sk-</code>) and paste it below.
			</>,
		],
		footer: (
			<>The Kimi API is prepaid — top up a small balance on the platform before agents run.</>
		),
	},
	[AiProvider.XAi]: {
		title: 'How to get your xAI API key',
		steps: [
			<>
				Sign in to the <InstructionsLink href="https://console.x.ai/">xAI Console</InstructionsLink>{' '}
				(or create an account).
			</>,
			<>
				Open{' '}
				<InstructionsLink href="https://console.x.ai/team/default/api-keys">
					API keys
				</InstructionsLink>{' '}
				and click <strong>Create API key</strong>.
			</>,
			<>
				Copy the key (starts with <code>xai-</code>) and paste it below — it's only shown once.
			</>,
		],
		footer: (
			<>
				Runs use xAI's <strong>Grok Build</strong> CLI on the <code>grok-4.5</code> model. API usage
				is billed per token — add credits under the console's Billing settings before agents run.
			</>
		),
	},
};

/** The gray, provider-specific "how to get your API key" box. */
export function ApiKeyInstructions({ provider }: { provider: AiProvider }) {
	return <InstructionsBox content={API_KEY_INSTRUCTIONS[provider]} />;
}

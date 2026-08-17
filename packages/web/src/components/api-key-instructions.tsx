import { AiProvider } from '@hezo/shared';
import {
	InstructionsBox,
	InstructionsLink,
	type ProviderInstructionContent,
} from './provider-instructions';

/**
 * One key, either CLI. Hezo can drive Moonshot's models through Claude Code or
 * through Moonshot's own Kimi Code CLI (pick under Advanced); both authenticate
 * with the same key from the same console.
 */
const KIMI_KEY_INSTRUCTIONS: ProviderInstructionContent = {
	title: 'How to get your Kimi API key',
	steps: [
		<>
			Sign in to the{' '}
			<InstructionsLink href="https://platform.kimi.ai/">Kimi Open Platform</InstructionsLink>{' '}
			(Moonshot AI's developer console).
		</>,
		<>
			Open{' '}
			<InstructionsLink href="https://platform.kimi.ai/console/api-keys">API keys</InstructionsLink>{' '}
			and click <strong>Create API key</strong>.
		</>,
		<>
			Copy the key (starts with <code>sk-</code>) and paste it below.
		</>,
	],
	footer: <>The Kimi API is prepaid - top up a small balance on the platform before agents run.</>,
};

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
				Copy the key (starts with <code>sk-ant-</code>) and paste it below - it's only shown once.
			</>,
		],
		footer: (
			<>
				API usage is billed per token from prepaid credits - add credits under the Console's Billing
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
				Copy the key (starts with <code>sk-</code>) and paste it below - it's only shown once.
			</>,
		],
		footer: (
			<>
				API usage is billed separately from ChatGPT - add a payment method under the platform's
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
				AI Studio keys start on a free tier with strict rate limits - enable billing on the key's
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
			<>Copy the key and paste it below - it's only shown once.</>,
		],
		footer: (
			<>The DeepSeek API is prepaid - top up your balance on the platform before agents run.</>
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
				Usage is billed from your prepaid balance - top up on the{' '}
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
				Copy the key (starts with <code>sk-or-</code>) and paste it below - it's only shown once.
			</>,
		],
		footer: (
			<>
				One OpenRouter key routes to models from many labs. Usage is prepaid - buy credits in your
				OpenRouter account before agents run.
			</>
		),
	},
	[AiProvider.Kimi]: KIMI_KEY_INSTRUCTIONS,
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
				Copy the key (starts with <code>xai-</code>) and paste it below - it's only shown once.
			</>,
		],
		footer: (
			<>
				Runs use xAI's <strong>Grok Build</strong> CLI on the <code>grok-4.5</code> model. API usage
				is billed per token - add credits under the console's Billing settings before agents run.
			</>
		),
	},
	// The two local runners take setup steps rather than key-console links: there
	// is no key to fetch, and the thing that actually needs getting right is the
	// server URL as seen from inside the agent container.
	[AiProvider.Ollama]: {
		title: 'How to connect your Ollama server',
		steps: [
			<>
				Install <InstructionsLink href="https://ollama.com/download">Ollama</InstructionsLink> and
				pull a model, for example <code>ollama pull qwen3-coder</code>.
			</>,
			<>
				Start the server with <code>ollama serve</code>. It listens on{' '}
				<code>http://localhost:11434</code> by default.
			</>,
			<>
				Set <strong>Server URL</strong> to an address the agent container can reach -{' '}
				<code>http://host.docker.internal:11434</code> for a server on this machine.
			</>,
		],
		footer: (
			<>
				Ollama serves Anthropic's Messages API, so agents run on the <strong>Claude Code</strong>{' '}
				CLI. Runs on your own hardware cost nothing per token, so they record <code>$0</code>. Pick
				a model with strong tool-calling - weaker local models struggle with agentic work.
			</>
		),
	},
	[AiProvider.LmStudio]: {
		title: 'How to connect your LM Studio server',
		steps: [
			<>
				Install <InstructionsLink href="https://lmstudio.ai/download">LM Studio</InstructionsLink>{' '}
				and download a model from its Discover tab.
			</>,
			<>
				Open the <strong>Developer</strong> tab and start the local server. It listens on{' '}
				<code>http://localhost:1234</code> by default.
			</>,
			<>
				Set <strong>Server URL</strong> to an address the agent container can reach -{' '}
				<code>http://host.docker.internal:1234</code> for a server on this machine. If you enabled{' '}
				<strong>Require Authentication</strong>, put the key under <strong>Advanced</strong>.
			</>,
		],
		footer: (
			<>
				LM Studio serves Anthropic's Messages API from version 0.4.1, so agents run on the{' '}
				<strong>Claude Code</strong> CLI. Runs on your own hardware cost nothing per token, so they
				record <code>$0</code>. Pick a model with strong tool-calling - weaker local models struggle
				with agentic work.
			</>
		),
	},
};

/** The gray, provider-specific "how to get your API key" box. */
export function ApiKeyInstructions({ provider }: { provider: AiProvider }) {
	return <InstructionsBox content={API_KEY_INSTRUCTIONS[provider]} />;
}

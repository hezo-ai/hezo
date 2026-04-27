import { AiProvider } from '@hezo/shared';
import { Loader2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from './ui/button';

export interface SubscriptionPasteFormProps {
	provider: AiProvider;
	onSubmit: (authJson: string) => Promise<void> | void;
	onCancel: () => void;
	pending: boolean;
}

interface ProviderInstructions {
	title: string;
	steps: ReactNode[];
	footer: ReactNode;
	placeholder: string;
}

const INSTRUCTIONS: Partial<Record<AiProvider, ProviderInstructions>> = {
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
};

export function SubscriptionPasteForm({
	provider,
	onSubmit,
	onCancel,
	pending,
}: SubscriptionPasteFormProps) {
	const [authJson, setAuthJson] = useState('');
	const instructions = INSTRUCTIONS[provider];

	if (!instructions) {
		return (
			<p className="text-[13px] text-accent-red mt-2">
				Subscription paste flow is not available for this provider.
			</p>
		);
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		await onSubmit(authJson);
	}

	return (
		<form onSubmit={handleSubmit} className="mt-2 flex flex-col gap-3">
			<div className="rounded-radius-md border border-border bg-bg-subtle p-3 text-[13px] text-text-muted">
				<p className="font-medium text-text mb-2">{instructions.title}</p>
				<ol className="list-decimal pl-5 space-y-1">
					{instructions.steps.map((step, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: instruction list is static
						<li key={i}>{step}</li>
					))}
				</ol>
				<p className="mt-2">{instructions.footer}</p>
			</div>

			<textarea
				required
				value={authJson}
				onChange={(e) => setAuthJson(e.target.value)}
				placeholder={instructions.placeholder}
				rows={6}
				spellCheck={false}
				className="w-full rounded-radius-md border border-border bg-bg-subtle px-2 py-1.5 text-xs font-mono text-text outline-none focus:border-border-hover"
			/>

			<div className="flex gap-2">
				<Button type="submit" size="sm" disabled={!authJson.trim() || pending}>
					{pending && <Loader2 className="w-3 h-3 animate-spin" />}
					Save
				</Button>
				<Button type="button" variant="secondary" size="sm" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</form>
	);
}

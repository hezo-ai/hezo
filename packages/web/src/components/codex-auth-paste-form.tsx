import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from './ui/button';

export interface CodexAuthPasteFormProps {
	providerName: string;
	onSubmit: (authJson: string) => Promise<void> | void;
	onCancel: () => void;
	pending: boolean;
}

export function CodexAuthPasteForm({
	providerName,
	onSubmit,
	onCancel,
	pending,
}: CodexAuthPasteFormProps) {
	const [authJson, setAuthJson] = useState('');

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		await onSubmit(authJson);
	}

	return (
		<form onSubmit={handleSubmit} className="mt-2 flex flex-col gap-3">
			<div className="rounded-radius-md border border-border bg-bg-subtle p-3 text-[13px] text-text-muted">
				<p className="font-medium text-text mb-2">
					How to get your {providerName} subscription auth file
				</p>
				<ol className="list-decimal pl-5 space-y-1">
					<li>
						Install the Codex CLI on your local machine: <code>npm install -g @openai/codex</code>.
					</li>
					<li>
						Run <code>codex login</code>. A browser window will open at <code>auth.openai.com</code>{' '}
						— sign in with the ChatGPT account whose subscription you want to use.
					</li>
					<li>
						Open <code>~/.codex/auth.json</code> (macOS/Linux) or{' '}
						<code>%USERPROFILE%\.codex\auth.json</code> (Windows).
					</li>
					<li>Copy the entire contents of that file and paste them into the box below.</li>
				</ol>
				<p className="mt-2">
					Heads up: this credential auto-rotates each time Hezo runs Codex. Don't keep using the
					same login on your laptop afterwards — pick one or the other, otherwise the refresh token
					will desync. To stop, remove the credential here and re-run <code>codex login</code>{' '}
					locally.
				</p>
			</div>

			<textarea
				required
				value={authJson}
				onChange={(e) => setAuthJson(e.target.value)}
				placeholder='{"tokens":{"refresh_token":"...","access_token":"...","id_token":"..."}}'
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

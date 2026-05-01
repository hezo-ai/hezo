import { AI_PROVIDER_INFO, AiAuthMethod, AiProvider } from '@hezo/shared';
import { ClipboardPaste, Key, Loader2, Shield } from 'lucide-react';
import { useState } from 'react';
import { useCreateAiProvider } from '../hooks/use-ai-providers';
import { SubscriptionPasteForm } from './subscription-paste-form';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';

const PROVIDERS = [
	AiProvider.DeepSeek,
	AiProvider.Anthropic,
	AiProvider.OpenAI,
	AiProvider.Google,
] as const;

export function AiProviderSetupModal() {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div className="bg-bg border border-border rounded-radius-lg shadow-lg w-full max-w-xl mx-4 p-6 max-h-[90vh] overflow-y-auto">
				<div className="flex items-center gap-2 mb-1">
					<Shield className="w-5 h-5 text-text-muted" />
					<h2 className="text-lg font-semibold">Set up an AI provider</h2>
				</div>
				<p className="text-[13px] text-text-muted mb-6">
					Configure at least one AI provider so your agents can run. These credentials are shared
					across every company in this Hezo instance.
				</p>

				<div className="space-y-3">
					{PROVIDERS.map((provider) => (
						<ProviderCard key={provider} provider={provider} />
					))}
				</div>
			</div>
		</div>
	);
}

function ProviderCard({ provider }: { provider: AiProvider }) {
	const info = AI_PROVIDER_INFO[provider];
	const [showKeyForm, setShowKeyForm] = useState(false);
	const [showPasteForm, setShowPasteForm] = useState(false);
	const [apiKey, setApiKey] = useState('');
	const createProvider = useCreateAiProvider();

	async function handleSubmitKey(e: React.FormEvent) {
		e.preventDefault();
		await createProvider.mutateAsync({ provider, api_key: apiKey });
		setApiKey('');
		setShowKeyForm(false);
	}

	async function handleSubmitPaste(authJson: string) {
		await createProvider.mutateAsync({
			provider,
			api_key: authJson,
			auth_method: AiAuthMethod.Subscription,
		});
		setShowPasteForm(false);
	}

	return (
		<div className="border border-border rounded-radius-md p-4">
			<div className="flex items-center justify-between mb-2">
				<div>
					<span className="text-[13px] font-medium">{info.name}</span>
					<Badge color="neutral" className="ml-2">
						{info.runtimeLabel}
					</Badge>
				</div>
			</div>

			{showKeyForm ? (
				<form onSubmit={handleSubmitKey} className="flex gap-2 mt-2">
					<Input
						type="password"
						placeholder={info.keyPlaceholder}
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						required
						className="flex-1"
					/>
					<Button type="submit" size="sm" disabled={createProvider.isPending}>
						{createProvider.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
						Save
					</Button>
					<Button type="button" variant="secondary" size="sm" onClick={() => setShowKeyForm(false)}>
						Cancel
					</Button>
				</form>
			) : showPasteForm ? (
				<SubscriptionPasteForm
					provider={provider}
					onSubmit={handleSubmitPaste}
					onCancel={() => setShowPasteForm(false)}
					pending={createProvider.isPending}
				/>
			) : (
				<div className="flex gap-2 mt-2">
					{info.supportsSubscription && (
						<Button variant="secondary" size="sm" onClick={() => setShowPasteForm(true)}>
							<ClipboardPaste className="w-3 h-3" />
							Use {info.runtimeLabel} subscription
						</Button>
					)}
					<Button variant="secondary" size="sm" onClick={() => setShowKeyForm(true)}>
						<Key className="w-3 h-3" />
						Enter API key
					</Button>
				</div>
			)}

			{createProvider.error && (
				<p className="text-[13px] text-accent-red mt-2">
					{(createProvider.error as { message?: string }).message || 'Failed to save'}
				</p>
			)}
		</div>
	);
}

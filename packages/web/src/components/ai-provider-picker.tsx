import { AI_PROVIDER_INFO, AiAuthMethod, AiProvider } from '@hezo/shared';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useCreateAiProvider } from '../hooks/use-ai-providers';
import { ProviderCardGrid } from './provider-card-grid';
import { ProviderLogo } from './provider-logos';
import { SUBSCRIPTION_INSTRUCTIONS, SubscriptionInstructions } from './subscription-paste-form';
import { Button } from './ui/button';
import { Input } from './ui/input';

// Display order mirrors the catalogue order used elsewhere in the app.
const PROVIDERS: readonly AiProvider[] = [
	AiProvider.DeepSeek,
	AiProvider.ZAi,
	AiProvider.Anthropic,
	AiProvider.OpenAI,
	AiProvider.Google,
	AiProvider.OpenRouter,
	AiProvider.Kimi,
	AiProvider.XAi,
];

/**
 * Onboarding AI-provider setup: a grid of provider cards. Picking one drills
 * into a form showing only the credential inputs that provider supports (an API
 * key, or — where available — a runtime-subscription paste). "Back" returns to
 * the full card view. Submitting fires the create mutation; the rest of the work
 * (verification, encryption, persistence) happens server-side from there.
 */
export function AiProviderPicker() {
	const [provider, setProvider] = useState<AiProvider | null>(null);

	if (!provider) {
		return <ProviderCardGrid providers={PROVIDERS} onSelect={setProvider} />;
	}

	return <ProviderConfigForm provider={provider} onBack={() => setProvider(null)} />;
}

function ProviderConfigForm({ provider, onBack }: { provider: AiProvider; onBack: () => void }) {
	const info = AI_PROVIDER_INFO[provider];
	const createProvider = useCreateAiProvider();
	const [authMethod, setAuthMethod] = useState<AiAuthMethod>(AiAuthMethod.ApiKey);
	const [apiKey, setApiKey] = useState('');
	const [authJson, setAuthJson] = useState('');
	const [error, setError] = useState<string | null>(null);

	const credential = authMethod === AiAuthMethod.Subscription ? authJson : apiKey;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!credential.trim()) return;
		try {
			await createProvider.mutateAsync({
				provider,
				api_key: credential,
				auth_method: authMethod,
			});
			// Success: the wizard advances once a provider is configured. Returning
			// to the grid keeps the surface coherent if it re-renders first.
			onBack();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to add provider');
		}
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={onBack}
					className="text-text-2 hover:text-text-1 p-2 -m-2"
					aria-label="Back"
				>
					<ArrowLeft className="w-4 h-4" />
				</button>
				<span className="flex h-6 w-6 items-center justify-center text-text-1">
					<ProviderLogo provider={provider} className="h-5 w-5" />
				</span>
				<div className="flex flex-col">
					<span className="text-sm font-medium text-text-1">Connect {info.name}</span>
					<span className="text-xs text-text-3">{info.runtimeLabel}</span>
				</div>
			</div>

			{info.supportsSubscription && (
				<div className="flex flex-col gap-1.5">
					<span className="text-eyebrow text-text-2">Authentication</span>
					<div className="flex gap-2">
						<Button
							type="button"
							size="sm"
							variant={authMethod === AiAuthMethod.ApiKey ? 'primary' : 'secondary'}
							onClick={() => {
								setAuthMethod(AiAuthMethod.ApiKey);
								setError(null);
							}}
						>
							API key
						</Button>
						<Button
							type="button"
							size="sm"
							variant={authMethod === AiAuthMethod.Subscription ? 'primary' : 'secondary'}
							onClick={() => {
								setAuthMethod(AiAuthMethod.Subscription);
								setError(null);
							}}
						>
							{info.runtimeLabel} subscription
						</Button>
					</div>
				</div>
			)}

			{authMethod === AiAuthMethod.Subscription ? (
				<div className="flex flex-col gap-2">
					<SubscriptionInstructions provider={provider} />
					<textarea
						required
						aria-label="Subscription credential"
						value={authJson}
						onChange={(e) => setAuthJson(e.target.value)}
						placeholder={SUBSCRIPTION_INSTRUCTIONS[provider]?.placeholder}
						rows={6}
						spellCheck={false}
						className="w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs font-mono text-text-1 outline-none focus:border-border-strong"
					/>
				</div>
			) : (
				<Input
					label="API key"
					type="password"
					placeholder={info.keyPlaceholder}
					value={apiKey}
					onChange={(e) => setApiKey(e.target.value)}
				/>
			)}

			{error && <p className="text-[13px] text-danger">{error}</p>}

			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" onClick={onBack}>
					Cancel
				</Button>
				<Button type="submit" disabled={!credential.trim() || createProvider.isPending}>
					{createProvider.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
					Save
				</Button>
			</div>
		</form>
	);
}

import { AI_PROVIDER_INFO, AiAuthMethod, AiProvider } from '@hezo/shared';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
	type AiProviderConfig,
	useAiProviders,
	useCreateAiProvider,
} from '../hooks/use-ai-providers';
import { SUBSCRIPTION_INSTRUCTIONS, SubscriptionInstructions } from './subscription-paste-form';
import { Button } from './ui/button';
import { Input } from './ui/input';

// Display order mirrors the catalogue order used elsewhere in the app. Shared by
// every surface that renders the provider card grid (onboarding + settings).
// OpenRouter (OpenCode runtime) is intentionally omitted from the picker for now
// — the plumbing stays in place, but it's hidden until we've confirmed whether
// its runs report cost in output.
export const ADD_PROVIDER_ORDER: readonly AiProvider[] = [
	AiProvider.DeepSeek,
	AiProvider.ZAi,
	AiProvider.Anthropic,
	AiProvider.OpenAI,
	AiProvider.Google,
	AiProvider.Kimi,
];

/**
 * Friendly default name for a new config, skipping labels already used for that
 * provider so the `UNIQUE(provider, label)` constraint never trips on the
 * suggested default.
 */
export function defaultLabel(
	provider: AiProvider,
	configs: AiProviderConfig[] | undefined,
): string {
	const info = AI_PROVIDER_INFO[provider];
	const used = new Set((configs ?? []).filter((c) => c.provider === provider).map((c) => c.label));
	if (!used.has(info.name)) return info.name;
	let n = 2;
	while (used.has(`${info.name} ${n}`)) n++;
	return `${info.name} ${n}`;
}

interface ProviderConfigFormProps {
	provider: AiProvider;
	/** Called after the credential is successfully created. */
	onDone: () => void;
	/** Called when the user cancels out of the form. */
	onCancel: () => void;
	/** Show an editable, auto-prefilled name field (settings flow). */
	showName?: boolean;
	/** Submit-button label. */
	submitLabel?: string;
}

/**
 * The provider credential form, shared by the onboarding picker and the
 * settings "Add provider" modal. Renders only the inputs the selected provider
 * supports — an API key, or (where available) a runtime-subscription paste —
 * plus an optional name field. Owns no surrounding chrome (heading, stepper,
 * back affordance); the caller supplies that so the same form works in both an
 * onboarding page and a modal. Mount with a `key={provider}` so switching
 * providers resets the in-progress credential.
 */
export function ProviderConfigForm({
	provider,
	onDone,
	onCancel,
	showName = false,
	submitLabel = 'Add provider',
}: ProviderConfigFormProps) {
	const { data: configs } = useAiProviders();
	const createProvider = useCreateAiProvider();
	const info = AI_PROVIDER_INFO[provider];

	const [authMethod, setAuthMethod] = useState<AiAuthMethod>(AiAuthMethod.ApiKey);
	const [name, setName] = useState(() => defaultLabel(provider, configs));
	const [nameEdited, setNameEdited] = useState(false);
	const [apiKey, setApiKey] = useState('');
	const [authJson, setAuthJson] = useState('');
	const [error, setError] = useState<string | null>(null);

	// Keep the name pinned to the generated default until the user edits it
	// (also re-syncs once the async configs query resolves).
	useEffect(() => {
		if (!nameEdited) setName(defaultLabel(provider, configs));
	}, [configs, nameEdited, provider]);

	const credential = authMethod === AiAuthMethod.Subscription ? authJson : apiKey;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!credential.trim()) return;
		try {
			await createProvider.mutateAsync({
				provider,
				api_key: credential,
				label: showName ? name.trim() || undefined : undefined,
				auth_method: authMethod,
			});
			onDone();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to add provider');
		}
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
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

			{showName && (
				<Input
					label="Name"
					value={name}
					placeholder={info.name}
					onChange={(e) => {
						setName(e.target.value);
						setNameEdited(true);
					}}
				/>
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
				<Button type="button" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" disabled={!credential.trim() || createProvider.isPending}>
					{createProvider.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
					{submitLabel}
				</Button>
			</div>
		</form>
	);
}

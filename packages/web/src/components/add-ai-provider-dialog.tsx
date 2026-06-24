import { AI_PROVIDER_INFO, AiAuthMethod, AiProvider } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
	type AiProviderConfig,
	useAiProviders,
	useCreateAiProvider,
} from '../hooks/use-ai-providers';
import { SUBSCRIPTION_INSTRUCTIONS, SubscriptionInstructions } from './subscription-paste-form';
import { Button } from './ui/button';
import { dialogContentClassName, dialogOverlayClassName } from './ui/dialog';
import { Input } from './ui/input';

// Display order mirrors the catalogue order used elsewhere in the app.
const ADD_PROVIDER_ORDER: AiProvider[] = [
	AiProvider.DeepSeek,
	AiProvider.ZAi,
	AiProvider.Anthropic,
	AiProvider.OpenAI,
	AiProvider.Google,
	AiProvider.OpenRouter,
	AiProvider.Kimi,
];

/**
 * Generate a friendly default name for a new config based on the selected
 * provider, skipping labels already used for that provider so the
 * `UNIQUE(provider, label)` constraint never trips on the suggested default.
 */
function defaultLabel(provider: AiProvider, configs: AiProviderConfig[] | undefined): string {
	const info = AI_PROVIDER_INFO[provider];
	const used = new Set((configs ?? []).filter((c) => c.provider === provider).map((c) => c.label));
	if (!used.has(info.name)) return info.name;
	let n = 2;
	while (used.has(`${info.name} ${n}`)) n++;
	return `${info.name} ${n}`;
}

interface AddAiProviderDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function AddAiProviderDialog({ open, onOpenChange }: AddAiProviderDialogProps) {
	const { data: configs } = useAiProviders();
	const createProvider = useCreateAiProvider();

	const [provider, setProvider] = useState<AiProvider>(AiProvider.Anthropic);
	const [authMethod, setAuthMethod] = useState<AiAuthMethod>(AiAuthMethod.ApiKey);
	const [name, setName] = useState('');
	const [nameEdited, setNameEdited] = useState(false);
	const [apiKey, setApiKey] = useState('');
	const [authJson, setAuthJson] = useState('');
	const [error, setError] = useState<string | null>(null);

	const info = AI_PROVIDER_INFO[provider];
	const generatedName = useMemo(() => defaultLabel(provider, configs), [provider, configs]);

	// Reset the whole form each time the dialog opens.
	useEffect(() => {
		if (!open) return;
		setProvider(AiProvider.Anthropic);
		setAuthMethod(AiAuthMethod.ApiKey);
		setNameEdited(false);
		setApiKey('');
		setAuthJson('');
		setError(null);
	}, [open]);

	// Keep the name pinned to the generated default until the user edits it
	// (also re-syncs once the async configs query resolves).
	useEffect(() => {
		if (!nameEdited) setName(generatedName);
	}, [generatedName, nameEdited]);

	function handleProviderChange(next: AiProvider) {
		setProvider(next);
		setNameEdited(false);
		setApiKey('');
		setAuthJson('');
		setError(null);
		if (!AI_PROVIDER_INFO[next].supportsSubscription) setAuthMethod(AiAuthMethod.ApiKey);
	}

	const credential = authMethod === AiAuthMethod.Subscription ? authJson : apiKey;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!credential.trim()) return;
		try {
			await createProvider.mutateAsync({
				provider,
				api_key: credential,
				label: name.trim() || undefined,
				auth_method: authMethod,
			});
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to add provider');
		}
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content className={dialogContentClassName.md}>
					<div className="flex items-center justify-between mb-1">
						<Dialog.Title className="text-lg font-semibold">Add AI provider</Dialog.Title>
						<Dialog.Close asChild>
							<button
								type="button"
								className="text-text-2 hover:text-text-1 p-2 -m-2"
								aria-label="Close"
							>
								<X className="w-4 h-4" />
							</button>
						</Dialog.Close>
					</div>
					<Dialog.Description className="text-[13px] text-text-2 mb-4">
						API keys for AI coding agents. Shared across every team in this Hezo instance.
					</Dialog.Description>

					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<label className="flex flex-col gap-1.5">
							<span className="text-eyebrow text-text-2">Provider</span>
							<select
								aria-label="Provider"
								value={provider}
								onChange={(e) => handleProviderChange(e.target.value as AiProvider)}
								className="h-8 rounded-md border border-border-strong bg-surface px-2.5 text-[13px] text-text-1 outline-none focus:border-accent"
							>
								{ADD_PROVIDER_ORDER.map((p) => (
									<option key={p} value={p}>
										{AI_PROVIDER_INFO[p].name} · {AI_PROVIDER_INFO[p].runtimeLabel}
									</option>
								))}
							</select>
						</label>

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

						<Input
							label="Name"
							value={name}
							placeholder={info.name}
							onChange={(e) => {
								setName(e.target.value);
								setNameEdited(true);
							}}
						/>

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
							<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!credential.trim() || createProvider.isPending}>
								{createProvider.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
								Add provider
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

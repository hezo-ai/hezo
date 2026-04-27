import { AI_PROVIDER_INFO, AiAuthMethod, AiProvider } from '@hezo/shared';
import { Check, ClipboardPaste, Key, Loader2, ShieldCheck, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import {
	type AiProviderConfig,
	useAiProviderModels,
	useAiProviders,
	useCreateAiProvider,
	useDeleteAiProvider,
	useSetDefaultAiProvider,
	useUpdateAiProviderConfig,
	useVerifyAiProvider,
} from '../hooks/use-ai-providers';
import { SubscriptionPasteForm } from './subscription-paste-form';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';

const AI_PROVIDERS_ORDER: AiProvider[] = [
	AiProvider.Anthropic,
	AiProvider.OpenAI,
	AiProvider.Google,
];

export function AiProvidersSection() {
	const { data: configs } = useAiProviders();
	const createProvider = useCreateAiProvider();
	const deleteProvider = useDeleteAiProvider();
	const verifyProvider = useVerifyAiProvider();
	const setDefaultProvider = useSetDefaultAiProvider();
	const [addingProvider, setAddingProvider] = useState<AiProvider | null>(null);
	const [pastingProvider, setPastingProvider] = useState<AiProvider | null>(null);
	const [apiKey, setApiKey] = useState('');
	const [label, setLabel] = useState('');
	const [verifyResult, setVerifyResult] = useState<
		Record<string, { valid: boolean; error?: string }>
	>({});

	async function handleSaveKey(provider: AiProvider) {
		await createProvider.mutateAsync({ provider, api_key: apiKey, label: label || undefined });
		setApiKey('');
		setLabel('');
		setAddingProvider(null);
	}

	async function handleSavePaste(provider: AiProvider, authJson: string) {
		await createProvider.mutateAsync({
			provider,
			api_key: authJson,
			auth_method: AiAuthMethod.Subscription,
		});
		setPastingProvider(null);
	}

	async function handleVerify(configId: string) {
		const result = await verifyProvider.mutateAsync(configId);
		setVerifyResult((prev) => ({ ...prev, [configId]: result }));
	}

	return (
		<section>
			<div className="mb-4">
				<h2 className="text-base font-medium">AI providers</h2>
				<p className="text-[13px] text-text-muted mt-1">
					API keys for AI coding agents. Shared across every company in this Hezo instance.
				</p>
			</div>
			<div className="flex flex-col gap-2">
				{AI_PROVIDERS_ORDER.map((provider) => {
					const info = AI_PROVIDER_INFO[provider];
					const providerConfigs = configs?.filter((c) => c.provider === provider) ?? [];
					const hasApiKey = providerConfigs.some((c) => c.auth_method === AiAuthMethod.ApiKey);
					const hasSubscription = providerConfigs.some(
						(c) => c.auth_method === AiAuthMethod.Subscription,
					);
					const canAddSubscription = info.supportsSubscription && !hasSubscription;
					const canAddApiKey = !hasApiKey;
					const isAdding = addingProvider === provider;
					const isPasting = pastingProvider === provider;
					const showMultipleControls = providerConfigs.length > 1;

					return (
						<div key={provider} className="border border-border rounded-radius-md p-3 bg-bg">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<span className="text-[13px] font-medium">{info.name}</span>
									<span className="text-xs text-text-subtle">{info.runtimeLabel}</span>
								</div>
							</div>

							{providerConfigs.map((config) => (
								<ConfigRow
									key={config.id}
									config={config}
									showDefaultControls={showMultipleControls}
									verify={verifyResult[config.id]}
									onVerify={() => handleVerify(config.id)}
									onRemove={() => deleteProvider.mutate(config.id)}
									onSetDefault={() => setDefaultProvider.mutate(config.id)}
									verifyPending={verifyProvider.isPending}
									setDefaultPending={setDefaultProvider.isPending}
								/>
							))}

							{(canAddSubscription || canAddApiKey) && !isAdding && !isPasting && (
								<div className="flex items-center gap-2 mt-2">
									{canAddSubscription && (
										<Button
											variant="secondary"
											size="sm"
											onClick={() => setPastingProvider(provider)}
										>
											<ClipboardPaste className="w-3 h-3" /> Use {info.runtimeLabel} subscription
										</Button>
									)}
									{canAddApiKey && (
										<Button
											variant="secondary"
											size="sm"
											onClick={() => setAddingProvider(provider)}
										>
											<Key className="w-3 h-3" /> Enter API key
										</Button>
									)}
								</div>
							)}

							{isPasting && (
								<SubscriptionPasteForm
									provider={provider}
									onSubmit={(authJson) => handleSavePaste(provider, authJson)}
									onCancel={() => setPastingProvider(null)}
									pending={createProvider.isPending}
								/>
							)}

							{isAdding && (
								<div className="flex flex-col gap-2 mt-2">
									<Input
										type="password"
										placeholder={info.keyPlaceholder}
										value={apiKey}
										onChange={(e) => setApiKey(e.target.value)}
									/>
									<Input
										placeholder="Label (optional)"
										value={label}
										onChange={(e) => setLabel(e.target.value)}
									/>
									<div className="flex gap-2">
										<Button
											size="sm"
											onClick={() => handleSaveKey(provider)}
											disabled={!apiKey.trim() || createProvider.isPending}
										>
											{createProvider.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
											Save
										</Button>
										<Button
											variant="secondary"
											size="sm"
											onClick={() => {
												setAddingProvider(null);
												setApiKey('');
												setLabel('');
											}}
										>
											Cancel
										</Button>
									</div>
									{createProvider.error && (
										<p className="text-[13px] text-accent-red">
											{(createProvider.error as { message: string }).message}
										</p>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</section>
	);
}

interface ConfigRowProps {
	config: AiProviderConfig;
	showDefaultControls: boolean;
	verify: { valid: boolean; error?: string } | undefined;
	onVerify: () => void;
	onRemove: () => void;
	onSetDefault: () => void;
	verifyPending: boolean;
	setDefaultPending: boolean;
}

function ConfigRow({
	config,
	showDefaultControls,
	verify,
	onVerify,
	onRemove,
	onSetDefault,
	verifyPending,
	setDefaultPending,
}: ConfigRowProps) {
	return (
		<div className="mt-2 border-t border-border pt-2">
			<div className="flex items-center gap-2 flex-wrap">
				<Badge color="neutral">
					{config.auth_method === AiAuthMethod.Subscription ? 'Subscription' : 'API Key'}
				</Badge>
				<Badge
					color={
						config.status === 'active'
							? 'success'
							: config.status === 'invalid'
								? 'danger'
								: 'neutral'
					}
				>
					{config.status}
				</Badge>
				{showDefaultControls && config.is_default && <Badge color="neutral">Default</Badge>}
				<span className="text-xs text-text-subtle truncate">{config.label}</span>
				<div className="flex-1" />
				{showDefaultControls && !config.is_default && (
					<Button variant="secondary" size="sm" onClick={onSetDefault} disabled={setDefaultPending}>
						Set default
					</Button>
				)}
				<Button variant="secondary" size="sm" onClick={onVerify} disabled={verifyPending}>
					{verifyPending ? (
						<Loader2 className="w-3 h-3 animate-spin" />
					) : (
						<ShieldCheck className="w-3 h-3" />
					)}
					Verify
				</Button>
				<Button variant="danger-text" size="sm" onClick={onRemove}>
					<Trash2 className="w-3 h-3" /> Remove
				</Button>
			</div>
			<DefaultModelSelector config={config} />
			{verify && (
				<div
					className={`mt-2 flex items-center gap-1.5 text-[13px] ${verify.valid ? 'text-accent-green-text' : 'text-accent-red'}`}
				>
					{verify.valid ? (
						<>
							<Check className="w-3.5 h-3.5" /> Key is valid
						</>
					) : (
						<>
							<X className="w-3.5 h-3.5" /> {verify.error || 'Key is invalid'}
						</>
					)}
				</div>
			)}
		</div>
	);
}

function DefaultModelSelector({ config }: { config: AiProviderConfig }) {
	const [open, setOpen] = useState(false);
	const models = useAiProviderModels(config.id, { enabled: open });
	const update = useUpdateAiProviderConfig(config.id);

	async function handleChange(value: string) {
		await update.mutateAsync({ default_model: value || null });
	}

	return (
		<div className="mt-2 flex items-center gap-2 text-[13px]">
			<label className="flex items-center gap-2">
				<span className="text-text-muted text-xs">Default model</span>
				<select
					aria-label={`Default model for ${config.label}`}
					value={config.default_model ?? ''}
					onFocus={() => setOpen(true)}
					onChange={(e) => handleChange(e.target.value)}
					className="rounded-md border border-border bg-bg-subtle px-2 py-1 text-xs text-text outline-none focus:border-border-hover"
					disabled={update.isPending}
				>
					<option value="">Use CLI default</option>
					{config.default_model && !models.data?.some((m) => m.id === config.default_model) && (
						<option value={config.default_model}>{config.default_model}</option>
					)}
					{models.data?.map((m) => (
						<option key={m.id} value={m.id}>
							{m.label}
						</option>
					))}
				</select>
			</label>
			{(models.isFetching || update.isPending) && (
				<Loader2 className="w-3 h-3 animate-spin text-text-subtle" />
			)}
			{models.error && (
				<span className="text-accent-red text-xs">
					{(models.error as { message?: string }).message || 'Failed to load models'}
				</span>
			)}
		</div>
	);
}

import { AI_PROVIDER_INFO, AiProvider } from '@hezo/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, Check, ExternalLink, Key, Loader2, ShieldCheck, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
	useAiProviders,
	useCreateAiProvider,
	useDeleteAiProvider,
	useStartAiProviderOAuth,
	useVerifyAiProvider,
} from '../../hooks/use-ai-providers';

const AI_PROVIDERS_ORDER: AiProvider[] = [
	AiProvider.Anthropic,
	AiProvider.OpenAI,
	AiProvider.Google,
	AiProvider.Moonshot,
];

function AiProvidersPage() {
	const { data: configs } = useAiProviders();
	const createProvider = useCreateAiProvider();
	const deleteProvider = useDeleteAiProvider();
	const verifyProvider = useVerifyAiProvider();
	const startOAuth = useStartAiProviderOAuth();
	const [addingProvider, setAddingProvider] = useState<AiProvider | null>(null);
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

	async function handleOAuth(provider: AiProvider) {
		const result = await startOAuth.mutateAsync(provider);
		window.location.href = result.auth_url;
	}

	async function handleVerify(configId: string) {
		const result = await verifyProvider.mutateAsync(configId);
		setVerifyResult((prev) => ({ ...prev, [configId]: result }));
	}

	return (
		<div className="max-w-[900px] mx-auto w-full px-8 py-6">
			<div className="flex items-center gap-3 mb-6">
				<Link
					to="/companies"
					className="text-text-muted hover:text-text inline-flex items-center gap-1 text-[13px]"
				>
					<ArrowLeft className="w-3.5 h-3.5" /> Back
				</Link>
			</div>
			<div className="mb-5">
				<h1 className="text-[22px] font-medium">AI providers</h1>
				<p className="text-[13px] text-text-muted mt-1">
					API keys for AI coding agents. Shared across every company in this Hezo instance.
				</p>
			</div>
			<div className="flex flex-col gap-2">
				{AI_PROVIDERS_ORDER.map((provider) => {
					const info = AI_PROVIDER_INFO[provider];
					const config = configs?.find((c) => c.provider === provider);
					const isAdding = addingProvider === provider;
					const verify = config ? verifyResult[config.id] : undefined;

					return (
						<div key={provider} className="border border-border rounded-radius-md p-3 bg-bg">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<span className="text-[13px] font-medium">{info.name}</span>
									<span className="text-xs text-text-subtle">{info.runtimeLabel}</span>
								</div>
								{config && (
									<div className="flex items-center gap-2">
										<Badge color="neutral">
											{config.auth_method === 'oauth_token' ? 'OAuth' : 'API Key'}
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
									</div>
								)}
							</div>

							{config && (
								<div className="flex items-center gap-2 mt-2">
									{config.label && <span className="text-xs text-text-subtle">{config.label}</span>}
									<div className="flex-1" />
									<Button
										variant="secondary"
										size="sm"
										onClick={() => handleVerify(config.id)}
										disabled={verifyProvider.isPending}
									>
										{verifyProvider.isPending ? (
											<Loader2 className="w-3 h-3 animate-spin" />
										) : (
											<ShieldCheck className="w-3 h-3" />
										)}
										Verify
									</Button>
									<Button
										variant="danger-text"
										size="sm"
										onClick={() => deleteProvider.mutate(config.id)}
									>
										<Trash2 className="w-3 h-3" /> Remove
									</Button>
								</div>
							)}

							{config && verify && (
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

							{!config && !isAdding && (
								<div className="flex items-center gap-2 mt-2">
									{info.supportsOAuth && (
										<Button
											variant="secondary"
											size="sm"
											onClick={() => handleOAuth(provider)}
											disabled={startOAuth.isPending}
										>
											{startOAuth.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
											<ExternalLink className="w-3 h-3" /> Connect via OAuth
										</Button>
									)}
									<Button variant="secondary" size="sm" onClick={() => setAddingProvider(provider)}>
										<Key className="w-3 h-3" /> Enter API key
									</Button>
								</div>
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
			{startOAuth.error && (
				<p className="text-[13px] text-accent-red mt-2">
					{(startOAuth.error as { message: string }).message}
				</p>
			)}
		</div>
	);
}

export const Route = createFileRoute('/settings/ai-providers')({
	component: AiProvidersPage,
});

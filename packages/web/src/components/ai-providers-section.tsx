import { AI_PROVIDER_INFO, AiAuthMethod, type AiProvider } from '@hezo/shared';
import { Loader2, Plus, ShieldCheck, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
	type AiProviderConfig,
	useAiProviderModels,
	useAiProviders,
	useDeleteAiProvider,
	useSetDefaultAiProvider,
	useUpdateAiProviderConfig,
	useVerifyAiProvider,
} from '../hooks/use-ai-providers';
import { toast } from '../hooks/use-toast';
import { AddAiProviderDialog } from './add-ai-provider-dialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { type Column, DataTable } from './ui/data-table';
import { Tooltip } from './ui/tooltip';

export function AiProvidersSection() {
	const { data: configs } = useAiProviders();
	const deleteProvider = useDeleteAiProvider();
	const verifyProvider = useVerifyAiProvider();
	const setDefaultProvider = useSetDefaultAiProvider();
	const [addOpen, setAddOpen] = useState(false);
	// Per-row transient "verified OK" marker — failures surface as a toast and a
	// refetched `invalid` status badge, so only successes need an inline cue.
	const [verifiedOk, setVerifiedOk] = useState<Record<string, boolean>>({});
	const [verifyingId, setVerifyingId] = useState<string | null>(null);

	const rows = configs ?? [];

	function providerCount(provider: string) {
		return rows.filter((c) => c.provider === provider).length;
	}

	async function handleVerify(configId: string) {
		setVerifyingId(configId);
		try {
			const result = await verifyProvider.mutateAsync(configId);
			setVerifiedOk((prev) => ({ ...prev, [configId]: result.valid }));
			if (!result.valid) {
				toast.error(result.message ?? result.error ?? 'Key is invalid or expired');
			}
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not verify key');
		} finally {
			setVerifyingId(null);
		}
	}

	const columns: Column<AiProviderConfig>[] = [
		{
			key: 'name',
			header: 'Name',
			render: (c) => (
				<span className="flex items-center gap-2">
					<span className="font-mono text-[13px]">{c.label}</span>
					{c.is_default && providerCount(c.provider) > 1 && <Badge color="accent">Default</Badge>}
				</span>
			),
		},
		{
			key: 'provider',
			header: 'Provider',
			render: (c) => {
				const info = AI_PROVIDER_INFO[c.provider as AiProvider];
				return (
					<span className="flex items-center gap-2">
						<span className="text-[13px]">{info?.name ?? c.provider}</span>
						{info && <span className="text-xs text-text-3">{info.runtimeLabel}</span>}
					</span>
				);
			},
		},
		{
			key: 'auth',
			header: 'Auth',
			hideOnMobile: true,
			render: (c) => (
				<Badge color="neutral">
					{c.auth_method === AiAuthMethod.Subscription ? 'Subscription' : 'API Key'}
				</Badge>
			),
		},
		{
			key: 'status',
			header: 'Status',
			render: (c) => (
				<Badge
					color={c.status === 'active' ? 'success' : c.status === 'invalid' ? 'danger' : 'neutral'}
				>
					{c.status}
				</Badge>
			),
		},
		{
			key: 'model',
			header: 'Default model',
			hideOnMobile: true,
			render: (c) => <DefaultModelSelector config={c} />,
		},
		{
			key: 'actions',
			header: '',
			render: (c) => {
				const multiple = providerCount(c.provider) > 1;
				return (
					<span className="flex items-center gap-2 justify-end">
						{verifiedOk[c.id] && (
							<Tooltip content="Key is valid">
								<ShieldCheck className="w-3.5 h-3.5 text-success-soft-fg" />
							</Tooltip>
						)}
						{multiple && !c.is_default && (
							<Tooltip content="Set as default">
								<button
									type="button"
									onClick={() => setDefaultProvider.mutate(c.id)}
									disabled={setDefaultProvider.isPending}
									aria-label={`Set ${c.label} as default`}
									className="text-text-3 hover:text-text-1 disabled:opacity-50"
								>
									<Star className="w-3.5 h-3.5" />
								</button>
							</Tooltip>
						)}
						<Tooltip content="Verify">
							<button
								type="button"
								onClick={() => handleVerify(c.id)}
								disabled={verifyingId === c.id}
								aria-label={`Verify ${c.label}`}
								className="text-text-3 hover:text-text-1 disabled:opacity-50"
							>
								{verifyingId === c.id ? (
									<Loader2 className="w-3.5 h-3.5 animate-spin" />
								) : (
									<ShieldCheck className="w-3.5 h-3.5" />
								)}
							</button>
						</Tooltip>
						<Tooltip content="Remove">
							<button
								type="button"
								onClick={() => deleteProvider.mutate(c.id)}
								aria-label={`Remove ${c.label}`}
								className="text-text-3 hover:text-danger"
							>
								<Trash2 className="w-3.5 h-3.5" />
							</button>
						</Tooltip>
					</span>
				);
			},
		},
	];

	return (
		<section>
			<div className="flex items-start justify-between gap-3 mb-4">
				<div>
					<h2 className="text-base font-medium">AI providers</h2>
					<p className="text-[13px] text-text-2 mt-1">
						API keys for AI coding agents. Shared across every team in this Hezo instance.
					</p>
				</div>
				<Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
					<Plus className="w-3 h-3" /> Add provider
				</Button>
			</div>

			{rows.length === 0 ? (
				<p className="text-[13px] text-text-2">
					No AI providers configured yet. Add one to get started.
				</p>
			) : (
				<DataTable columns={columns} data={rows} rowKey={(c) => c.id} />
			)}

			<AddAiProviderDialog open={addOpen} onOpenChange={setAddOpen} />
		</section>
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
		<div className="flex items-center gap-2 text-[13px]">
			<select
				aria-label={`Default model for ${config.label}`}
				value={config.default_model ?? ''}
				onFocus={() => setOpen(true)}
				onChange={(e) => handleChange(e.target.value)}
				className="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-text-1 outline-none focus:border-border-strong"
				disabled={update.isPending}
			>
				<option value="">CLI default</option>
				{config.default_model && !models.data?.some((m) => m.id === config.default_model) && (
					<option value={config.default_model}>{config.default_model}</option>
				)}
				{models.data?.map((m) => (
					<option key={m.id} value={m.id}>
						{m.label}
					</option>
				))}
			</select>
			{(models.isFetching || update.isPending) && (
				<Loader2 className="w-3 h-3 animate-spin text-text-3" />
			)}
			{models.error && (
				<span className="text-danger text-xs">
					{(models.error as { message?: string }).message || 'Failed to load models'}
				</span>
			)}
		</div>
	);
}

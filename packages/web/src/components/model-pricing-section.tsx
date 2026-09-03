import { AiProviderStatus } from '@hezo/shared';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAiProviders, useAllProviderModels } from '../hooks/use-ai-providers';
import { useMe } from '../hooks/use-me';
import {
	type CreateOverridePayload,
	type ModelPricingRow,
	useCreateModelPricingOverride,
	useDeleteModelPricingOverride,
	useModelPricing,
	useRefreshModelPricing,
} from '../hooks/use-model-pricing';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { type Column, DataTable } from './ui/data-table';
import { HelpDialog } from './ui/help-dialog';
import { InPlaceForm } from './ui/in-place-form';
import { Input } from './ui/input';
import { Tooltip } from './ui/tooltip';

const PER_MILLION = 1_000_000;

/** Per-token rate → "$X.XX" per million tokens, the friendlier unit to read/enter. */
function fmtPerMillion(perToken: number | null): string {
	if (perToken == null) return '-';
	return `$${(perToken * PER_MILLION).toFixed(2)}`;
}

/** Parse a "$/Mtok" form field to a per-token rate. Returns undefined if invalid. */
function parsePerMillion(value: string): number | undefined {
	const trimmed = value.trim();
	if (trimmed === '') return undefined;
	const n = Number(trimmed);
	if (!Number.isFinite(n) || n < 0) return undefined;
	return n / PER_MILLION;
}

/**
 * Model pricing management, rendered below the AI providers table on the
 * AI providers settings page. Superuser-only: returns null for board users so
 * the page they *can* reach (for the provider list) doesn't show a dead panel.
 */
export function ModelPricingSection() {
	const { data: me } = useMe();
	const { data: rows = [] } = useModelPricing();
	const createOverride = useCreateModelPricingOverride();
	const deleteOverride = useDeleteModelPricingOverride();
	const refresh = useRefreshModelPricing();

	const [showForm, setShowForm] = useState(false);

	// Dynamic model suggestions for the free-text id field, drawn from the live
	// catalogs of every verified provider. Fetched only while the form is open so
	// the page doesn't fan out live calls on mount. The field stays free-text —
	// custom/self-hosted model ids that no catalog lists remain valid.
	const { data: providers } = useAiProviders();
	const verifiedConfigIds = useMemo(
		() => (providers ?? []).filter((p) => p.status === AiProviderStatus.Verified).map((p) => p.id),
		[providers],
	);
	const { models: suggestedModels } = useAllProviderModels(verifiedConfigIds, {
		enabled: showForm,
	});

	const [modelId, setModelId] = useState('');
	const [input, setInput] = useState('');
	const [output, setOutput] = useState('');
	const [cacheRead, setCacheRead] = useState('');
	const [cacheCreation, setCacheCreation] = useState('');
	const [error, setError] = useState<string | null>(null);

	function resetForm() {
		setShowForm(false);
		setModelId('');
		setInput('');
		setOutput('');
		setCacheRead('');
		setCacheCreation('');
		setError(null);
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		const inputRate = parsePerMillion(input);
		const outputRate = parsePerMillion(output);
		if (!modelId.trim() || inputRate === undefined || outputRate === undefined) {
			setError('Model id, input, and output rates are required (non-negative numbers).');
			return;
		}
		// Empty cache fields → null (lookup falls back to the input rate).
		const cacheReadRate = cacheRead.trim() === '' ? null : parsePerMillion(cacheRead);
		const cacheCreationRate = cacheCreation.trim() === '' ? null : parsePerMillion(cacheCreation);
		if (cacheReadRate === undefined || cacheCreationRate === undefined) {
			setError('Cache rates must be non-negative numbers (or left blank).');
			return;
		}
		const payload: CreateOverridePayload = {
			model_id: modelId.trim(),
			input_per_token: inputRate,
			output_per_token: outputRate,
			cache_read_per_token: cacheReadRate,
			cache_creation_per_token: cacheCreationRate,
		};
		try {
			await createOverride.mutateAsync(payload);
			resetForm();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save override');
		}
	}

	const columns: Column<ModelPricingRow>[] = [
		{
			key: 'model_id',
			header: 'Model',
			render: (r) => (
				<span className="flex items-center gap-2">
					<span className="font-mono text-[13px]">{r.model_id}</span>
					<Badge color={r.source === 'manual' ? 'purple' : 'neutral'}>{r.source}</Badge>
				</span>
			),
		},
		{
			key: 'input',
			header: 'Input /Mtok',
			render: (r) => <span className="text-xs font-mono">{fmtPerMillion(r.input_per_token)}</span>,
		},
		{
			key: 'output',
			header: 'Output /Mtok',
			render: (r) => <span className="text-xs font-mono">{fmtPerMillion(r.output_per_token)}</span>,
		},
		{
			key: 'cache_read',
			header: 'Cache read /Mtok',
			hideOnMobile: true,
			render: (r) => (
				<span className="text-xs font-mono">{fmtPerMillion(r.cache_read_per_token)}</span>
			),
		},
		{
			key: 'cache_creation',
			header: 'Cache write /Mtok',
			hideOnMobile: true,
			render: (r) => (
				<span className="text-xs font-mono">{fmtPerMillion(r.cache_creation_per_token)}</span>
			),
		},
		{
			key: 'actions',
			header: '',
			render: (r) =>
				r.source === 'manual' ? (
					<span className="flex items-center justify-end">
						<Tooltip content="Remove override">
							<button
								type="button"
								onClick={() => {
									if (confirm(`Remove the manual price override for "${r.model_id}"?`)) {
										deleteOverride.mutate(r.id);
									}
								}}
								aria-label={`Remove override for ${r.model_id}`}
								className="text-text-3 hover:text-danger"
							>
								<Trash2 className="w-3.5 h-3.5" />
							</button>
						</Tooltip>
					</span>
				) : null,
		},
	];

	// Board users can reach the AI providers page but don't manage pricing.
	if (me && !me.is_superuser) return null;

	return (
		<section className="mt-10 pt-8 border-t border-border">
			<div className="flex items-start justify-between gap-3 mb-4">
				<div className="flex items-center gap-1.5">
					<h2 className="text-base font-medium">Model pricing</h2>
					<HelpDialog
						title="How run costs are calculated"
						triggerLabel="How run costs are calculated"
						data-testid="model-pricing-help"
					>
						<div className="flex flex-col gap-3 text-sm text-text-2 leading-relaxed">
							<p>
								<span className="font-semibold text-text-1">
									Every run is priced from this table.
								</span>{' '}
								Hezo multiplies the token counts each runtime reports by these per-model rates.
								Dollar figures a runtime emits itself (e.g.{' '}
								<span className="font-mono">total_cost_usd</span>) are ignored - they are
								client-side estimates from the CLI's own rate card, which is wrong for third-party
								endpoints.
							</p>
							<p>
								Rates refresh from <span className="font-mono">pricepertoken.com</span> daily and at
								startup; the Refresh button forces one now.
							</p>
							<p>
								<span className="font-semibold text-text-1">
									Cache traffic is priced separately.
								</span>{' '}
								The catalog carries no cache rates, so Hezo derives them from each model's own input
								rate - cache reads at a fraction of it, cache writes at a small premium. Where a
								provider's multipliers are not yet known, cache traffic still bills at the full
								input rate, which makes those figures an upper bound rather than an exact one.
							</p>
							<p>
								A manual override wins over the catalog for its model and <em>can</em> set cache
								rates - add one for exact billing, to correct a rate, or to price a model the
								catalog lacks.
							</p>
						</div>
					</HelpDialog>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					<Button
						variant="secondary"
						size="sm"
						onClick={() => refresh.mutate()}
						disabled={refresh.isPending}
					>
						<RefreshCw className={`w-3 h-3 ${refresh.isPending ? 'animate-spin' : ''}`} /> Refresh
					</Button>
					<Button
						variant="secondary"
						size="sm"
						onClick={() => (showForm ? resetForm() : setShowForm(true))}
					>
						<Plus className="w-3 h-3" /> Override
					</Button>
				</div>
			</div>

			{showForm && (
				<InPlaceForm title="Add price override" onClose={resetForm} onSubmit={handleSubmit}>
					<Input
						placeholder="Model id (e.g. my-custom-model)"
						value={modelId}
						onChange={(e) => setModelId(e.target.value)}
						list="model-pricing-model-ids"
						required
					/>
					<datalist id="model-pricing-model-ids">
						{suggestedModels.map((m) => (
							<option key={m.id} value={m.id}>
								{m.label}
							</option>
						))}
					</datalist>
					<div className="flex flex-col sm:flex-row gap-2">
						<Input
							placeholder="Input $ / Mtok"
							value={input}
							onChange={(e) => setInput(e.target.value)}
							required
							wrapperClassName="flex-1"
						/>
						<Input
							placeholder="Output $ / Mtok"
							value={output}
							onChange={(e) => setOutput(e.target.value)}
							required
							wrapperClassName="flex-1"
						/>
					</div>
					<div className="flex flex-col sm:flex-row gap-2">
						<Input
							placeholder="Cache read $ / Mtok (optional)"
							value={cacheRead}
							onChange={(e) => setCacheRead(e.target.value)}
							wrapperClassName="flex-1"
						/>
						<Input
							placeholder="Cache write $ / Mtok (optional)"
							value={cacheCreation}
							onChange={(e) => setCacheCreation(e.target.value)}
							wrapperClassName="flex-1"
						/>
					</div>
					{error && <p className="text-[13px] text-danger">{error}</p>}
					<div className="flex gap-2">
						<Button type="submit" size="sm" disabled={createOverride.isPending}>
							Save override
						</Button>
						<Button type="button" variant="secondary" size="sm" onClick={resetForm}>
							Cancel
						</Button>
					</div>
				</InPlaceForm>
			)}

			{!rows.length ? (
				<p className="text-[13px] text-text-2">
					No pricing rows yet. Refresh from pricepertoken.com, or add a manual override above.
				</p>
			) : (
				<DataTable columns={columns} data={rows} rowKey={(row) => row.id} />
			)}
		</section>
	);
}

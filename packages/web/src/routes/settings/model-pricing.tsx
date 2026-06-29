import { createFileRoute } from '@tanstack/react-router';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { type Column, DataTable } from '../../components/ui/data-table';
import { InfoTooltip } from '../../components/ui/info-tooltip';
import { Input } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import { useMe } from '../../hooks/use-me';
import {
	type CreateOverridePayload,
	type ModelPricingRow,
	useCreateModelPricingOverride,
	useDeleteModelPricingOverride,
	useModelPricing,
	useRefreshModelPricing,
} from '../../hooks/use-model-pricing';

const PER_MILLION = 1_000_000;

/** Per-token rate → "$X.XX" per million tokens, the friendlier unit to read/enter. */
function fmtPerMillion(perToken: number | null): string {
	if (perToken == null) return '—';
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

function ModelPricingPage() {
	const { data: me } = useMe();
	const { data: rows = [] } = useModelPricing();
	const createOverride = useCreateModelPricingOverride();
	const deleteOverride = useDeleteModelPricingOverride();
	const refresh = useRefreshModelPricing();

	const [showForm, setShowForm] = useState(false);
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

	const content =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-2">
				Model pricing is managed by the Admin. You don't have access to this page.
			</p>
		) : (
			<>
				<div className="flex items-start justify-between gap-3 mb-4">
					<div>
						<div className="flex items-center gap-1.5">
							<h1 className="text-[22px] font-medium">Model pricing</h1>
							<InfoTooltip
								label="About model pricing"
								content="Per-model token rates used to compute the dollar cost of every agent run. Rows auto-refresh from the public LiteLLM feed; add a manual override for a model the feed lacks (or to correct one) — overrides win."
								data-testid="model-pricing-info"
							/>
						</div>
						<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
							Per-token rates that turn a run's token counts into a dollar cost, across every
							runtime. Feed rows refresh from <span className="font-mono">LiteLLM</span>; a manual
							override wins for that model — use it for ids the feed doesn't carry (e.g.{' '}
							<span className="font-mono">deepseek-v4-pro</span>
							).
						</p>
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
					<form onSubmit={handleSubmit} className="flex flex-col gap-2 mb-4">
						<Input
							placeholder="Model id (e.g. deepseek-v4-pro)"
							value={modelId}
							onChange={(e) => setModelId(e.target.value)}
							required
						/>
						<div className="flex flex-col sm:flex-row gap-2">
							<Input
								placeholder="Input $ / Mtok"
								value={input}
								onChange={(e) => setInput(e.target.value)}
								required
								className="flex-1"
							/>
							<Input
								placeholder="Output $ / Mtok"
								value={output}
								onChange={(e) => setOutput(e.target.value)}
								required
								className="flex-1"
							/>
						</div>
						<div className="flex flex-col sm:flex-row gap-2">
							<Input
								placeholder="Cache read $ / Mtok (optional)"
								value={cacheRead}
								onChange={(e) => setCacheRead(e.target.value)}
								className="flex-1"
							/>
							<Input
								placeholder="Cache write $ / Mtok (optional)"
								value={cacheCreation}
								onChange={(e) => setCacheCreation(e.target.value)}
								className="flex-1"
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
					</form>
				)}

				{!rows.length ? (
					<p className="text-[13px] text-text-2">
						No pricing rows yet. Refresh from the feed, or add a manual override above.
					</p>
				) : (
					<DataTable columns={columns} data={rows} rowKey={(row) => row.id} />
				)}
			</>
		);

	return <div className="max-w-[900px]">{content}</div>;
}

export const Route = createFileRoute('/settings/model-pricing')({
	component: ModelPricingPage,
});

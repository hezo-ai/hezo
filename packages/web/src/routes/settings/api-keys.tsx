import { ApiKeyStatus } from '@hezo/shared';
import { createFileRoute } from '@tanstack/react-router';
import { Check, Copy, Loader2, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { type Column, DataTable } from '../../components/ui/data-table';
import { InfoTooltip } from '../../components/ui/info-tooltip';
import { Input } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import {
	type ApiKey,
	useApiKeys,
	useApproveApiKey,
	useCreateApiKey,
	useDeleteApiKey,
} from '../../hooks/use-api-keys';
import { useMe } from '../../hooks/use-me';
import { copyToClipboard } from '../../lib/clipboard';

function formatRelative(iso: string | null): string {
	if (!iso) return 'never';
	const ms = Date.now() - new Date(iso).getTime();
	const min = 60 * 1000;
	const hr = 60 * min;
	const day = 24 * hr;
	if (ms < min) return 'just now';
	if (ms < hr) return `${Math.floor(ms / min)}m ago`;
	if (ms < day) return `${Math.floor(ms / hr)}h ago`;
	return `${Math.floor(ms / day)}d ago`;
}

function clientLabel(info: Record<string, unknown>): string | null {
	const name = typeof info.name === 'string' ? info.name : null;
	if (!name) return null;
	const version = typeof info.version === 'string' ? info.version : null;
	return version ? `${name} ${version}` : name;
}

function ApiKeysPage() {
	const { data: me } = useMe();
	const { data: rows = [] } = useApiKeys();
	const create = useCreateApiKey();
	const approve = useApproveApiKey();
	const remove = useDeleteApiKey();

	const [showForm, setShowForm] = useState(false);
	const [name, setName] = useState('');
	const [newKey, setNewKey] = useState<string | null>(null);

	const pending = rows.filter((r) => r.status === ApiKeyStatus.Pending);
	const active = rows.filter((r) => r.status === ApiKeyStatus.Approved);
	const busy = approve.isPending || remove.isPending;

	async function handleCreate(e: React.FormEvent) {
		e.preventDefault();
		const result = await create.mutateAsync({ name });
		setNewKey(result.key ?? null);
		setName('');
		setShowForm(false);
	}

	const clientColumn: Column<ApiKey> = {
		key: 'client',
		header: 'Client',
		hideOnMobile: true,
		render: (r) => {
			const label = clientLabel(r.client_info);
			return label ? (
				<span className="text-xs font-mono text-text-2">{label}</span>
			) : (
				<span className="text-text-3">—</span>
			);
		},
	};

	const pendingColumns: Column<ApiKey>[] = [
		{
			key: 'name',
			header: 'Name',
			render: (r) => <span className="font-medium text-[13px]">{r.name}</span>,
		},
		clientColumn,
		{
			key: 'requested',
			header: 'Requested',
			render: (r) => <span className="text-xs text-text-2">{formatRelative(r.created_at)}</span>,
		},
		{
			key: 'actions',
			header: '',
			render: (r) => (
				<span className="flex items-center gap-2 justify-end">
					<Button size="sm" variant="approve" disabled={busy} onClick={() => approve.mutate(r.id)}>
						{approve.isPending ? (
							<Loader2 className="w-3 h-3 animate-spin" />
						) : (
							<Check className="w-3 h-3" />
						)}
						Approve
					</Button>
					<Button
						size="sm"
						variant="ghost"
						className="text-danger"
						disabled={busy}
						onClick={() => {
							if (confirm(`Reject the access request from "${r.name}"?`)) {
								remove.mutate(r.id);
							}
						}}
					>
						<X className="w-3 h-3" /> Reject
					</Button>
				</span>
			),
		},
	];

	const activeColumns: Column<ApiKey>[] = [
		{
			key: 'name',
			header: 'Name',
			render: (r) => (
				<span className="flex items-center gap-2">
					<span className="font-medium text-[13px]">{r.name}</span>
					<span className="text-xs text-text-3 font-mono">hezo_{r.prefix}…</span>
				</span>
			),
		},
		clientColumn,
		{
			key: 'last_used',
			header: 'Last used',
			render: (r) => <span className="text-xs text-text-2">{formatRelative(r.last_used_at)}</span>,
		},
		{
			key: 'actions',
			header: '',
			render: (r) => (
				<span className="flex items-center gap-2 justify-end">
					<Tooltip content="Revoke">
						<Button
							size="sm"
							variant="ghost"
							className="text-danger"
							disabled={busy}
							onClick={() => {
								if (
									confirm(
										`Revoke "${r.name}"? Its token stops working immediately and it loses all access to this instance.`,
									)
								) {
									remove.mutate(r.id);
								}
							}}
						>
							<Trash2 className="w-3.5 h-3.5" /> Revoke
						</Button>
					</Tooltip>
				</span>
			),
		},
	];

	const content =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-2">
				API keys are managed by the Admin. You don't have access to this page.
			</p>
		) : (
			<>
				<div className="mb-5">
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-1.5">
							<h1 className="text-[22px] font-medium">API keys</h1>
							<InfoTooltip
								label="About API keys"
								content="API keys connect external tools and agents to this instance over MCP. Create one yourself, or approve a request from an external agent."
								data-testid="api-keys-info"
							/>
						</div>
						<Button variant="secondary" size="sm" onClick={() => setShowForm((v) => !v)}>
							<Plus className="w-3 h-3" /> Create
						</Button>
					</div>
					<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
						An API key connects an external tool or agent to this Hezo instance over MCP. A key acts
						with <span className="font-medium">full access</span> — every project and team — so only
						create or approve keys you trust. Revoke one at any time to disable it immediately.
					</p>
				</div>

				{newKey && (
					<div className="border border-success rounded-md bg-success-soft p-3 mb-5">
						<p className="text-xs text-success-soft-fg font-medium mb-1">
							New API key created — copy it now, it won't be shown again:
						</p>
						<div className="flex items-center gap-2">
							<code className="text-xs font-mono break-all flex-1">{newKey}</code>
							<Button variant="secondary" size="sm" onClick={() => copyToClipboard(newKey)}>
								<Copy className="w-3 h-3" />
							</Button>
						</div>
						<Button variant="secondary" size="sm" className="mt-2" onClick={() => setNewKey(null)}>
							Dismiss
						</Button>
					</div>
				)}

				{showForm && (
					<form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-2 mb-5">
						<Input
							placeholder="Key name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
							className="flex-1"
						/>
						<Button type="submit" size="sm" disabled={create.isPending}>
							Create
						</Button>
					</form>
				)}

				{pending.length > 0 && (
					<section className="mb-8">
						<h2 className="text-[13px] font-medium text-text-2 mb-2 flex items-center gap-2">
							Pending approval
							<Badge color="warning">{pending.length}</Badge>
						</h2>
						<DataTable columns={pendingColumns} data={pending} rowKey={(r) => r.id} />
					</section>
				)}

				<section>
					<h2 className="text-[13px] font-medium text-text-2 mb-2">Active</h2>
					{active.length ? (
						<DataTable columns={activeColumns} data={active} rowKey={(r) => r.id} />
					) : (
						<p className="text-[13px] text-text-2">
							No API keys yet. Create one above, or approve a request from an external agent.
						</p>
					)}
				</section>
			</>
		);

	return <div className="max-w-[900px]">{content}</div>;
}

export const Route = createFileRoute('/settings/api-keys')({
	component: ApiKeysPage,
});

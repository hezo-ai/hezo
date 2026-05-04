import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Badge } from '../../../components/ui/badge';
import { type Column, DataTable } from '../../../components/ui/data-table';
import { type AuditEntry, useAuditLog } from '../../../hooks/use-audit-log';

type TabKey = 'all' | 'egress';

const tabs: Array<{ key: TabKey; label: string; description: string }> = [
	{ key: 'all', label: 'All', description: 'Recent actions across the company.' },
	{
		key: 'egress',
		label: 'Outbound traffic',
		description:
			'Every outbound HTTPS request from an agent container that the egress proxy substituted a placeholder for, or denied. Values are never recorded — only the secret name.',
	},
];

const baseColumns: Column<AuditEntry>[] = [
	{
		key: 'time',
		header: 'Time',
		hideOnMobile: true,
		render: (e) => (
			<span className="text-xs text-text-subtle">{new Date(e.created_at).toLocaleString()}</span>
		),
	},
	{
		key: 'actor',
		header: 'Actor',
		render: (e) => <span className="text-xs">{e.actor_name || e.actor_type}</span>,
	},
	{
		key: 'action',
		header: 'Action',
		render: (e) => <Badge color="neutral">{e.action}</Badge>,
	},
	{
		key: 'entity',
		header: 'Entity',
		hideOnMobile: true,
		render: (e) => <span className="text-xs text-text-muted">{e.entity_type}</span>,
	},
];

const egressColumns: Column<AuditEntry>[] = [
	{
		key: 'time',
		header: 'Time',
		hideOnMobile: true,
		render: (e) => (
			<span className="text-xs text-text-subtle">{new Date(e.created_at).toLocaleString()}</span>
		),
	},
	{
		key: 'host',
		header: 'Host',
		render: (e) => {
			const host = (e.details as { host?: string }).host;
			return <span className="text-xs font-mono">{host ?? '—'}</span>;
		},
	},
	{
		key: 'method-path',
		header: 'Request',
		render: (e) => {
			const d = e.details as { method?: string; url_path?: string };
			return (
				<span className="text-xs font-mono">
					<Badge color="neutral">{d.method ?? 'GET'}</Badge>{' '}
					<span className="text-text-muted truncate">{d.url_path ?? '/'}</span>
				</span>
			);
		},
	},
	{
		key: 'status',
		header: 'Status',
		render: (e) => {
			const d = e.details as { status_code?: number | null; error?: string | null };
			if (d.error) {
				return <Badge color="danger">{d.error}</Badge>;
			}
			if (d.status_code) {
				return <Badge color="neutral">{d.status_code}</Badge>;
			}
			return <Badge color="success">forwarded</Badge>;
		},
	},
	{
		key: 'secrets',
		header: 'Secrets used',
		render: (e) => {
			const names = (e.details as { secret_names_used?: string[] }).secret_names_used ?? [];
			if (!names.length) return <span className="text-xs text-text-subtle">—</span>;
			return (
				<span className="flex flex-wrap gap-1">
					{names.map((n) => (
						<Badge key={n} color="blue">
							{n}
						</Badge>
					))}
				</span>
			);
		},
	},
	{
		key: 'agent',
		header: 'Agent',
		hideOnMobile: true,
		render: (e) => <span className="text-xs">{e.actor_name || '—'}</span>,
	},
];

function AuditLogPage() {
	const { companyId } = Route.useParams();
	const [tab, setTab] = useState<TabKey>('all');
	const filter = tab === 'egress' ? { entity_type: 'egress_request' } : undefined;
	const { data: entries } = useAuditLog(companyId, filter);
	const activeTab = tabs.find((t) => t.key === tab) ?? tabs[0];
	const columns = tab === 'egress' ? egressColumns : baseColumns;

	return (
		<div>
			<div className="mb-4">
				<h2 className="text-base font-medium">Audit log</h2>
				<p className="text-[13px] text-text-muted mt-1">{activeTab.description}</p>
			</div>
			<div className="flex gap-1 mb-4 border-b border-border-subtle">
				{tabs.map((t) => (
					<button
						key={t.key}
						type="button"
						onClick={() => setTab(t.key)}
						className={`px-3 py-1.5 text-[13px] -mb-px border-b-2 cursor-pointer transition-colors ${
							tab === t.key
								? 'border-accent-blue text-text font-medium'
								: 'border-transparent text-text-muted hover:text-text'
						}`}
					>
						{t.label}
					</button>
				))}
			</div>
			{!entries?.length ? (
				<p className="text-[13px] text-text-muted">
					{tab === 'egress' ? 'No egress events yet.' : 'No audit entries yet.'}
				</p>
			) : (
				<DataTable columns={columns} data={entries} rowKey={(row) => row.id} />
			)}
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/audit-log')({
	component: AuditLogPage,
});

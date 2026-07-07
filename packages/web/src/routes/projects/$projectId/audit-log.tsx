import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { AuditLogTable } from '../../../components/audit-log-table';
import { Badge } from '../../../components/ui/badge';
import { type Column, DataTable } from '../../../components/ui/data-table';
import { Tabs } from '../../../components/ui/tabs';
import { type AuditEntry, useProjectAuditLog } from '../../../hooks/use-audit-log';

type TabKey = 'all' | 'egress';

const tabs: Array<{ key: TabKey; label: string; description: string }> = [
	{
		key: 'all',
		label: 'All',
		description:
			'Everything that happened on this project — tasks, agent runs, documents, assets, and connector changes — newest first.',
	},
	{
		key: 'egress',
		label: 'Outbound traffic',
		description:
			'Every outbound HTTPS request from an agent container that the egress proxy substituted a placeholder for, or denied. Values are never recorded — only the secret name.',
	},
];

const egressColumns: Column<AuditEntry>[] = [
	{
		key: 'time',
		header: 'Time',
		hideOnMobile: true,
		render: (e) => (
			<span className="text-xs text-text-3">{new Date(e.created_at).toLocaleString()}</span>
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
					<span className="text-text-2 truncate">{d.url_path ?? '/'}</span>
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
			if (!names.length) return <span className="text-xs text-text-3">—</span>;
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

function ProjectAuditLogPage() {
	const { projectId } = Route.useParams();
	const [tab, setTab] = useState<TabKey>('all');
	const filter = tab === 'egress' ? { entity_type: 'egress_request' } : undefined;
	const { data: entries } = useProjectAuditLog(projectId, filter);
	const activeTab = tabs.find((t) => t.key === tab) ?? tabs[0];

	return (
		<div>
			<div className="mb-4">
				<h2 className="text-base font-medium">Activity</h2>
				<p className="text-[13px] text-text-2 mt-1">{activeTab.description}</p>
			</div>
			<Tabs
				items={tabs.map((t) => ({ key: t.key, label: t.label }))}
				value={tab}
				onValueChange={(k) => setTab(k as TabKey)}
				className="mb-4"
			/>
			{tab === 'egress' ? (
				!entries?.length ? (
					<p className="text-[13px] text-text-2">No outbound traffic recorded yet.</p>
				) : (
					<DataTable columns={egressColumns} data={entries} rowKey={(row) => row.id} />
				)
			) : (
				<AuditLogTable entries={entries} emptyText="No activity on this project yet." />
			)}
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/audit-log')({
	component: ProjectAuditLogPage,
});

import { createFileRoute } from '@tanstack/react-router';
import { Badge } from '../../../components/ui/badge';
import { type Column, DataTable } from '../../../components/ui/data-table';
import { type AuditEntry, useAuditLog } from '../../../hooks/use-audit-log';

const columns: Column<AuditEntry>[] = [
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

function AuditLogPage() {
	const { companyId } = Route.useParams();
	const { data: entries } = useAuditLog(companyId);

	return (
		<div>
			<div className="mb-4">
				<h2 className="text-base font-medium">Audit log</h2>
				<p className="text-[13px] text-text-muted mt-1">Recent actions across the company.</p>
			</div>
			{!entries?.length ? (
				<p className="text-[13px] text-text-muted">No audit entries yet.</p>
			) : (
				<DataTable columns={columns} data={entries} rowKey={(row) => row.id} />
			)}
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/audit-log')({
	component: AuditLogPage,
});

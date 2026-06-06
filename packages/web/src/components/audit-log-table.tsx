import type { AuditEntry } from '../hooks/use-audit-log';
import { Badge } from './ui/badge';
import { type Column, DataTable } from './ui/data-table';

/**
 * Shared renderer for the activity (audit) log, used by the team, per-project,
 * and instance views. Pass `showTeam` to surface the originating team — only
 * useful in the cross-team instance view.
 */
export function AuditLogTable({
	entries,
	showTeam = false,
	emptyText = 'No activity yet.',
}: {
	entries: AuditEntry[] | undefined;
	showTeam?: boolean;
	emptyText?: string;
}) {
	if (!entries?.length) {
		return <p className="text-[13px] text-text-muted">{emptyText}</p>;
	}
	return <DataTable columns={buildColumns(showTeam)} data={entries} rowKey={(row) => row.id} />;
}

function buildColumns(showTeam: boolean): Column<AuditEntry>[] {
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
			render: (e) => (
				<span className="text-xs">
					{e.actor_name || e.actor_type}
					{e.actor_name ? <span className="text-text-subtle"> · {e.actor_type}</span> : null}
				</span>
			),
		},
		{
			key: 'action',
			header: 'Action',
			render: (e) => <Badge color="neutral">{e.action}</Badge>,
		},
		{
			key: 'entity',
			header: 'Entity',
			render: (e) => {
				const name = (e.details as { name?: string; slug?: string; identifier?: string }).name;
				const label = name ?? (e.details as { identifier?: string }).identifier ?? null;
				return (
					<span className="text-xs text-text-muted">
						{e.entity_type}
						{label ? <span className="text-text"> · {label}</span> : null}
					</span>
				);
			},
		},
	];
	if (showTeam) {
		columns.push({
			key: 'team',
			header: 'Team',
			hideOnMobile: true,
			render: (e) => (
				<span className="text-xs text-text-muted">{e.team_name ?? <em>instance</em>}</span>
			),
		});
	}
	return columns;
}

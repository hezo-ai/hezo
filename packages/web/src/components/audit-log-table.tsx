import { Link } from '@tanstack/react-router';
import type { AuditEntry } from '../hooks/use-audit-log';
import { auditEntryLink, describeAuditEntry } from '../lib/audit-format';
import { ActorBadge } from './ui/actor-badge';
import { type Column, DataTable } from './ui/data-table';

/**
 * Shared renderer for the activity (audit) log, used by the per-project and
 * instance views. Pass `showProject` to surface the originating project — only
 * useful in the cross-project instance view.
 */
export function AuditLogTable({
	entries,
	showProject = false,
	emptyText = 'No activity yet.',
}: {
	entries: AuditEntry[] | undefined;
	showProject?: boolean;
	emptyText?: string;
}) {
	if (!entries?.length) {
		return <p className="text-[13px] text-text-2">{emptyText}</p>;
	}
	return <DataTable columns={buildColumns(showProject)} data={entries} rowKey={(row) => row.id} />;
}

function buildColumns(showProject: boolean): Column<AuditEntry>[] {
	const columns: Column<AuditEntry>[] = [
		{
			key: 'time',
			header: 'Time',
			hideOnMobile: true,
			render: (e) => (
				<span className="text-xs text-text-3">{new Date(e.created_at).toLocaleString()}</span>
			),
		},
		{
			key: 'actor',
			header: 'Actor',
			render: (e) => (
				<span className="inline-flex items-center gap-1 text-xs">
					<span>
						{e.actor_name || e.actor_type}
						{e.actor_name ? <span className="text-text-3"> · {e.actor_type}</span> : null}
					</span>
					<ActorBadge actorType={e.actor_type} name={e.actor_name} />
				</span>
			),
		},
		{
			key: 'activity',
			header: 'Activity',
			render: (e) => {
				const text = describeAuditEntry(e);
				const link = auditEntryLink(e);
				if (!link) return <span className="text-[13px] text-text-1">{text}</span>;
				return (
					<Link
						to={link.to}
						params={'params' in link ? link.params : undefined}
						className="text-[13px] text-text-1 hover:text-accent hover:underline"
					>
						{text}
					</Link>
				);
			},
		},
	];
	if (showProject) {
		columns.push({
			key: 'project',
			header: 'Project',
			hideOnMobile: true,
			render: (e) => (
				<span className="text-xs text-text-2">{e.project_name ?? <em>instance</em>}</span>
			),
		});
	}
	return columns;
}

import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { AuditLogTable } from '../../components/audit-log-table';
import { useInstanceAuditLog } from '../../hooks/use-audit-log';
import { useMe } from '../../hooks/use-me';

function InstanceAuditLogPage() {
	const { data: me } = useMe();
	const { data: entries } = useInstanceAuditLog();

	const body =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-muted">
				The instance activity log is managed by the Admin. You don't have access to this page.
			</p>
		) : (
			<>
				<div className="mb-4">
					<h1 className="text-[22px] font-medium">Instance activity</h1>
					<p className="text-[13px] text-text-muted mt-1 max-w-[680px]">
						Every state-changing action across all teams, plus instance-level admin actions
						(credentials, connectors, skills) that aren't tied to a team. The combined view for
						reconstructing what happened.
					</p>
				</div>
				<AuditLogTable entries={entries} showTeam emptyText="No activity recorded yet." />
			</>
		);

	return (
		<div className="max-w-[1000px] mx-auto w-full">
			<div className="flex items-center gap-3 mb-6">
				<Link
					to="/settings"
					className="text-text-muted hover:text-text inline-flex items-center gap-1 text-[13px]"
				>
					<ArrowLeft className="w-3.5 h-3.5" /> Settings
				</Link>
			</div>
			{body}
		</div>
	);
}

export const Route = createFileRoute('/settings/audit-log')({
	component: InstanceAuditLogPage,
});

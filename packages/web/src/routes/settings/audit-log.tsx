import { createFileRoute } from '@tanstack/react-router';
import { AuditLogTable } from '../../components/audit-log-table';
import { InfoTooltip } from '../../components/ui/info-tooltip';
import { useInstanceAuditLog } from '../../hooks/use-audit-log';
import { useMe } from '../../hooks/use-me';

function InstanceAuditLogPage() {
	const { data: me } = useMe();
	const { data: entries } = useInstanceAuditLog();

	const body =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-2">
				The instance activity log is managed by the Admin. You don't have access to this page.
			</p>
		) : (
			<>
				<div className="mb-4">
					<div className="flex items-center gap-1.5">
						<h1 className="text-[22px] font-medium">Activity</h1>
						<InfoTooltip
							label="About activity"
							content="Audit log of every state-changing action across all projects, plus instance-level admin actions."
							data-testid="activity-info"
						/>
					</div>
					<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
						Every state-changing action across all projects, plus instance-level admin actions
						(credentials, connectors, skills) that aren't tied to a project. The combined view for
						reconstructing what happened.
					</p>
				</div>
				<AuditLogTable entries={entries} showProject emptyText="No activity recorded yet." />
			</>
		);

	return (
		<div className="max-w-[1000px] w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">{body}</div>
	);
}

export const Route = createFileRoute('/settings/audit-log')({
	component: InstanceAuditLogPage,
});

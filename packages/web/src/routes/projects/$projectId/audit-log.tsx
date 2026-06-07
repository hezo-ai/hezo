import { createFileRoute } from '@tanstack/react-router';
import { AuditLogTable } from '../../../components/audit-log-table';
import { useProjectAuditLog } from '../../../hooks/use-audit-log';

function ProjectAuditLogPage() {
	const { projectId } = Route.useParams();
	const { data: entries } = useProjectAuditLog(projectId);

	return (
		<div className="px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			<div className="mb-4">
				<h2 className="text-base font-medium">Activity</h2>
				<p className="text-[13px] text-text-muted mt-1">
					Everything that happened on this project — tasks, agent runs, documents, assets, and
					connector changes — newest first.
				</p>
			</div>
			<AuditLogTable entries={entries} emptyText="No activity on this project yet." />
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/audit-log')({
	component: ProjectAuditLogPage,
});

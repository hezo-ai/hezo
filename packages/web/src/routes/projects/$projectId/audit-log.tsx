import { createFileRoute } from '@tanstack/react-router';
import { AuditLogTable } from '../../../components/audit-log-table';
import { LoadOlderActivity } from '../../../components/load-older-activity';
import { useProjectAuditLog } from '../../../hooks/use-audit-log';

function ProjectAuditLogPage() {
	const { projectId } = Route.useParams();
	const { entries, hasMore, loadMore, isLoadingMore } = useProjectAuditLog(projectId);

	return (
		<div>
			<div className="mb-4">
				<h2 className="text-base font-medium">Activity</h2>
				<p className="text-[13px] text-text-2 mt-1">
					Everything that happened on this project — tasks, agent runs, documents, assets, and
					connector changes — newest first.
				</p>
			</div>
			<AuditLogTable entries={entries} emptyText="No activity on this project yet." />
			<LoadOlderActivity hasMore={hasMore} loadMore={loadMore} isLoading={isLoadingMore} />
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/audit-log')({
	component: ProjectAuditLogPage,
});

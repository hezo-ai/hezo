import { createFileRoute } from '@tanstack/react-router';
import { AuditLogTable } from '../../../../components/audit-log-table';
import { LoadOlderActivity } from '../../../../components/load-older-activity';
import { useProjectAuditLog } from '../../../../hooks/use-audit-log';
import { useI18n } from '../../../../lib/i18n';

/** The Log tab: everything that happened on this project, newest first. */
function ProjectActivityLogPage() {
	const { t } = useI18n();
	const { projectId } = Route.useParams();
	const { entries, hasMore, loadMore, isLoadingMore } = useProjectAuditLog(projectId);

	return (
		<div>
			<p className="mb-4 max-w-prose text-[13px] text-text-2">{t('activity.log.description')}</p>
			<AuditLogTable entries={entries} emptyText={t('activity.log.empty')} />
			<LoadOlderActivity hasMore={hasMore} loadMore={loadMore} isLoading={isLoadingMore} />
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/activity/')({
	component: ProjectActivityLogPage,
});

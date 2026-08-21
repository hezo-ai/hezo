import { createFileRoute } from '@tanstack/react-router';
import { AuditLogTable } from '../../../components/audit-log-table';
import { LoadOlderActivity } from '../../../components/load-older-activity';
import { useProjectAuditLog } from '../../../hooks/use-audit-log';
import { useI18n } from '../../../lib/i18n';

/**
 * The project's Activity page: everything that happened, newest first.
 *
 * **A top-level project page, not a Settings sub-item.** It is a working surface
 * the team reads rather than configuration set once, and sidebar sub-items only
 * mount while their parent route is active - nested under Settings it was
 * invisible from every other page.
 *
 * It used to carry a second tab measuring per-agent run wall clock. That figure
 * now sits beside each agent's spend on the Budget page, where "how long did
 * this agent work" belongs next to "what did it cost"; the Budget page's own
 * Hours tab answers the different question of what the containers cost in
 * uptime. One page, one question again.
 */
function ProjectActivityPage() {
	const { t } = useI18n();
	const { projectId } = Route.useParams();
	const { entries, hasMore, loadMore, isLoadingMore } = useProjectAuditLog(projectId);

	return (
		<div>
			<h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-text-1">
				{t('nav.activity')}
			</h1>
			<p className="mt-1 max-w-prose text-[13px] text-text-2">{t('activity.subtitle')}</p>

			<div className="mt-5">
				<AuditLogTable entries={entries} emptyText={t('activity.log.empty')} />
				<LoadOlderActivity hasMore={hasMore} loadMore={loadMore} isLoading={isLoadingMore} />
			</div>
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/activity')({
	component: ProjectActivityPage,
});

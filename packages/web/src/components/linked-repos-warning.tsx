import type { LinkedRepo } from '@hezo/shared';
import { useI18n } from '../lib/i18n';
import { RelatedItemsList } from './related-items-list';

/**
 * The git repos a connector or an OAuth connection still authenticates, shown
 * inside a destructive confirmation so the consequence is named before the click
 * instead of discovered later.
 *
 * `kind` picks which consequence, and they are genuinely different. Removing the
 * connector row leaves git working - the repos keep their own reference to the
 * connection - and only strips the MCP tools agents were using. Deleting the
 * connection itself drops that reference too, so those remotes fall back to
 * anonymous clone: fine for a public repo, a bare 403 for a private one.
 *
 * Renders nothing when there is nothing to warn about, so every call site can
 * drop it into a dialog unconditionally.
 */
export function LinkedReposWarning({
	repos,
	kind,
}: {
	repos: LinkedRepo[] | undefined;
	kind: 'connector' | 'connection';
}) {
	const { t } = useI18n();
	if (!repos || repos.length === 0) return null;

	const consequence =
		kind === 'connector'
			? repos.length === 1
				? t('connectors.linkedRepos.connectorOne')
				: t('connectors.linkedRepos.connectorMany', { count: repos.length })
			: repos.length === 1
				? t('connectors.linkedRepos.connectionOne')
				: t('connectors.linkedRepos.connectionMany', { count: repos.length });

	return (
		<div className="flex flex-col gap-1" data-testid="linked-repos-warning">
			<span className="text-xs text-text-2">{consequence}</span>
			<RelatedItemsList
				label={t('connectors.linkedRepos.label')}
				testId="linked-repos-list"
				items={repos.map((repo) => ({
					key: repo.id,
					// The project name matters when a connection is shared: the repo that
					// breaks may not be in the project the operator is looking at.
					label: `${repo.repo_identifier} (${repo.project_name})`,
					title: repo.repo_identifier,
					testId: `linked-repo-${repo.id}`,
				}))}
			/>
		</div>
	);
}

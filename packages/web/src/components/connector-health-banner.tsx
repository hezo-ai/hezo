import { Link } from '@tanstack/react-router';
import { PlugZap } from 'lucide-react';
import { useConnectorHealth } from '../hooks/use-connectors';
import { useProjectMenuCollapsed } from '../hooks/use-project-menu-collapsed';
import { bannerInnerClass } from '../lib/banner-classes';
import { useI18n } from '../lib/i18n';

// Below ContainerStatusBanner (z-40) and BudgetBanner (z-30), and well below the
// collapsed-menu expand tab (z-50) - see the stacking note in __root.tsx.
const BANNER_OUTER = 'sticky top-0 z-20 bg-surface';

/**
 * Warns at the top of a project when a connector that used to work has stopped.
 *
 * A broken connector was previously invisible: the refresh failure was recorded
 * on a row whose status still read "Connected", so the only signal was a red
 * error string on the Connectors page - which nobody visits until something has
 * already gone wrong. Agent runs meanwhile kept calling the dead integration and
 * quietly produced degraded output. This is the signal that reaches the operator
 * without them going looking.
 *
 * Deliberately scoped to the working-to-broken case. A connector that has never
 * finished its first connect is a setup step the operator already knows about,
 * and banner-ing it would turn this into permanent furniture people learn to
 * ignore.
 */
export function ConnectorHealthBanner({ projectId }: { projectId: string }) {
	const { data } = useConnectorHealth(projectId);
	const [menuCollapsed] = useProjectMenuCollapsed();
	const { t } = useI18n();
	if (!data || data.count === 0) return null;

	const first = data.degraded[0];
	const message =
		data.count === 1
			? t('connectors.banner.one', { name: first.display_name ?? first.name })
			: t('connectors.banner.many', { count: data.count });

	return (
		<div className={BANNER_OUTER}>
			<Link
				to="/projects/$projectId/connectors"
				params={{ projectId }}
				search={data.count === 1 ? { focus: first.id } : {}}
				data-testid="connector-health-banner"
				aria-label={`${message} ${t('connectors.banner.action')}`}
				className={`${bannerInnerClass(menuCollapsed)} bg-warning/10 text-warning-soft-fg transition-colors hover:bg-warning/20`}
			>
				<PlugZap className="h-3.5 w-3.5 shrink-0" />
				<span data-testid="connector-health-banner-message" className="min-w-0 truncate">
					{message}
				</span>
				<span className="ml-auto hidden shrink-0 opacity-80 sm:inline">
					{t('connectors.banner.action')}
				</span>
			</Link>
		</div>
	);
}

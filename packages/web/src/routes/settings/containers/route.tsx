import { createFileRoute, Outlet } from '@tanstack/react-router';
import { InfoTooltip } from '../../../components/ui/info-tooltip';
import { Tabs } from '../../../components/ui/tabs';
import { useMe } from '../../../hooks/use-me';
import { useI18n } from '../../../lib/i18n';

/**
 * The containers page: what is running, and the limits it runs under.
 *
 * Two tabs rather than one page, because they answer different questions at
 * different times. The limits are configured once and then left alone; the list
 * is what an operator opens when something is wrong *now*. Folding a live fleet
 * view into a settings form would bury it under four numbers nobody is reading
 * at that moment.
 *
 * The gate and the header live here rather than on each tab: a duplicated
 * superuser check is how one of two surfaces ends up ungated, and this crosses
 * every project on the instance.
 */
function ContainersLayout() {
	const { t } = useI18n();
	const { data: me } = useMe();
	const tabs = [
		{ label: t('containers.tab.list'), to: '/settings/containers' as const },
		{ label: t('containers.tab.settings'), to: '/settings/containers/settings' as const },
	];

	if (me && !me.is_superuser) {
		return <p className="text-[13px] text-text-2">{t('concurrency.adminOnly')}</p>;
	}

	return (
		<div className="max-w-[900px]">
			<div className="flex items-center gap-1.5">
				<h1 className="text-[22px] font-medium">{t('settings.concurrency')}</h1>
				<InfoTooltip
					label={t('concurrency.about.label')}
					content={t('concurrency.about.content')}
					data-testid="concurrency-info"
				/>
			</div>
			<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">{t('concurrency.intro')}</p>
			{/*
			 * `Tabs` matches its route targets fuzzily, so the Containers tab stays
			 * active on a container's own detail page - which is where the operator
			 * still is, conceptually.
			 */}
			<Tabs items={tabs} className="mt-4 mb-5" />
			<Outlet />
		</div>
	);
}

export const Route = createFileRoute('/settings/containers')({
	component: ContainersLayout,
});

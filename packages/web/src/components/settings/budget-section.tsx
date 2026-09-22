import { useUsage } from '../../hooks/use-usage';
import { useI18n } from '../../lib/i18n';
import { SectionHeader } from './helpers';

export function BudgetSection({ projectId }: { projectId: string }) {
	const { t, formatNumber } = useI18n();
	const { data: usage } = useUsage(projectId, { group_by: 'agent' });
	return (
		<section>
			<SectionHeader title={t('settings.budget.title')} desc={t('settings.budget.description')} />
			{usage?.summary?.length === 0 ? (
				<p className="text-[13px] text-text-3">{t('budget.usage.chart.empty')}</p>
			) : (
				<div className="flex flex-col gap-1">
					{usage?.summary?.map((s) => (
						<div
							key={s.agent_id}
							className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
						>
							<span>{s.agent_name ?? s.agent_title}</span>
							<span className="font-mono">{formatNumber(s.total_tokens)}</span>
						</div>
					))}
					<div className="flex items-center justify-between px-3 py-2 text-[13px] font-medium border-t border-border mt-1 pt-2">
						<span>{t('settings.budget.total')}</span>
						<span className="font-mono">{formatNumber(usage?.total_tokens ?? 0)}</span>
					</div>
				</div>
			)}
		</section>
	);
}

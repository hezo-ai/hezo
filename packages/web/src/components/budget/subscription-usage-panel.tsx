import { AI_PROVIDER_INFO, type AiProvider, allowancePace } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Gauge, Pencil } from 'lucide-react';
import { useAiProviders } from '../../hooks/use-ai-providers';
import { useI18n } from '../../lib/i18n';
import { AllowanceWeekLine, configAllowance } from '../allowance-pacing-field';
import { BudgetBar } from '../ui/budget-bar';
import { SectionHeader } from '../ui/section-header';

/**
 * Where each subscription's week stands, beside the project's own budgets. A
 * subscription is shared by every project, so the section lists each one that
 * reports a window, whichever project the page is for. A window past its reset
 * says nothing about the new week, so it is left out until a run reports again.
 */
export function SubscriptionUsagePanel() {
	const { t } = useI18n();
	const { data: configs } = useAiProviders();
	const now = new Date();
	const paced = (configs ?? []).flatMap((config) => {
		const pace = allowancePace(configAllowance(config), config.allowance_daily_share_percent, now);
		return pace ? [{ config, pace }] : [];
	});
	if (paced.length === 0) return null;

	return (
		<section data-testid="subscription-usage">
			<SectionHeader
				icon={Gauge}
				title={t('budget.page.subscriptions.title')}
				description={t('budget.page.subscriptions.description')}
			/>
			<div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
				{paced.map(({ config, pace }) => (
					<div
						key={config.id}
						data-testid={`subscription-usage-${config.id}`}
						className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-xs"
					>
						<div className="flex items-center justify-between gap-2">
							<div className="flex min-w-0 flex-col">
								<span className="truncate font-mono text-[13px] font-medium text-text-1">
									{config.label}
								</span>
								<span className="text-xs text-text-3">
									{AI_PROVIDER_INFO[config.provider as AiProvider]?.name ?? config.provider}
								</span>
							</div>
							<Link
								to="/settings/ai-providers"
								aria-label={t('budget.page.subscriptions.editFor', { name: config.label })}
								title={t('budget.page.subscriptions.edit')}
								className="shrink-0 rounded-sm p-1 text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1"
							>
								<Pencil className="h-3.5 w-3.5" aria-hidden />
							</Link>
						</div>
						<BudgetBar used={pace.usedPercent} total={100} />
						<AllowanceWeekLine config={config} />
					</div>
				))}
			</div>
		</section>
	);
}

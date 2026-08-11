import { createFileRoute, Link } from '@tanstack/react-router';
import { Loader2, Store } from 'lucide-react';
import { HiringForBanner } from '../../components/hiring-for-banner';
import { Badge } from '../../components/ui/badge';
import { Card } from '../../components/ui/card';
import { useMarketplaceTeams } from '../../hooks/use-marketplace';
import { useI18n } from '../../lib/i18n';

interface MarketplaceSearch {
	/**
	 * Set when the operator arrived from a project's hire flow. It carries that
	 * project through the catalog so the add dialog opens already pointed at it -
	 * see `hire-agent-chooser-dialog.tsx`.
	 */
	forProject?: string;
}

function MarketplacePage() {
	const { t } = useI18n();
	const { data: teams, isLoading } = useMarketplaceTeams();
	const { forProject } = Route.useSearch();

	return (
		<div className="max-w-[1000px] mx-auto p-4 sm:p-6 lg:p-8" data-testid="marketplace-page">
			{forProject && (
				<HiringForBanner projectId={forProject} messageKey="agents.hire.hiringForPickTeam" />
			)}

			<div className="flex items-center gap-2 mb-1">
				<Store className="w-5 h-5 text-text-2" />
				<h1 className="text-xl font-semibold">{t('marketplace.title')}</h1>
			</div>
			<p className="text-[13px] text-text-2 mb-6">{t('marketplace.subtitle')}</p>

			{isLoading ? (
				<div className="flex items-center gap-2 text-text-2 text-[13px] py-8">
					<Loader2 className="w-4 h-4 animate-spin" /> {t('marketplace.loading')}
				</div>
			) : (teams ?? []).length === 0 ? (
				<p className="text-text-2 text-[13px]">{t('marketplace.empty')}</p>
			) : (
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
					{(teams ?? []).map((team) => (
						<Link
							key={team.slug}
							to="/marketplace/$slug"
							params={{ slug: team.slug }}
							search={forProject ? { forProject } : {}}
							className="block"
							data-testid={`marketplace-card-${team.slug}`}
						>
							<Card className="p-4 h-full transition-colors hover:border-accent-solid">
								<div className="flex items-start justify-between gap-2 mb-1">
									<h2 className="text-[15px] font-medium">{team.name}</h2>
									<Badge color="neutral">v{team.version}</Badge>
								</div>
								<p className="text-[13px] text-text-2 line-clamp-3 mb-3">{team.description}</p>
								<p className="text-[12px] text-text-2">
									{team.roster_count === 1
										? t('marketplace.roleCountOne')
										: t('marketplace.roleCountOther', { count: team.roster_count })}
								</p>
							</Card>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute('/marketplace/')({
	validateSearch: (search: Record<string, unknown>): MarketplaceSearch => ({
		forProject: typeof search.forProject === 'string' ? search.forProject : undefined,
	}),
	component: MarketplacePage,
});

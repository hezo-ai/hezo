import { createFileRoute, Link } from '@tanstack/react-router';
import { Loader2, Store } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import { Card } from '../../components/ui/card';
import { useMarketplaceTeams } from '../../hooks/use-marketplace';

function MarketplacePage() {
	const { data: teams, isLoading } = useMarketplaceTeams();

	return (
		<div className="max-w-[1000px] mx-auto p-4 sm:p-6 lg:p-8" data-testid="marketplace-page">
			<div className="flex items-center gap-2 mb-1">
				<Store className="w-5 h-5 text-text-2" />
				<h1 className="text-xl font-semibold">Team marketplace</h1>
			</div>
			<p className="text-[13px] text-text-2 mb-6">
				Ready-made teams you can launch as a new project or add to an existing one.
			</p>

			{isLoading ? (
				<div className="flex items-center gap-2 text-text-2 text-[13px] py-8">
					<Loader2 className="w-4 h-4 animate-spin" /> Loading teams…
				</div>
			) : (teams ?? []).length === 0 ? (
				<p className="text-text-2 text-[13px]">No marketplace teams are available right now.</p>
			) : (
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
					{(teams ?? []).map((t) => (
						<Link
							key={t.slug}
							to="/marketplace/$slug"
							params={{ slug: t.slug }}
							className="block"
							data-testid={`marketplace-card-${t.slug}`}
						>
							<Card className="p-4 h-full transition-colors hover:border-accent-solid">
								<div className="flex items-start justify-between gap-2 mb-1">
									<h2 className="text-[15px] font-medium">{t.name}</h2>
									<Badge color="neutral">v{t.version}</Badge>
								</div>
								<p className="text-[13px] text-text-2 line-clamp-3 mb-3">{t.description}</p>
								<p className="text-[12px] text-text-2">
									{t.roster_count} role{t.roster_count === 1 ? '' : 's'}
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
	component: MarketplacePage,
});

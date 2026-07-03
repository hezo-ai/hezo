import { useCosts } from '../../hooks/use-costs';
import { SectionHeader } from './helpers';

export function BudgetSection({ projectId }: { projectId: string }) {
	const { data: costs } = useCosts(projectId, { group_by: 'agent' });
	return (
		<section>
			<SectionHeader
				title="Budget"
				desc="Spending overview across agents. Token costs are computed at non-cached rates, so figures are a conservative upper-bound estimate."
			/>
			{costs?.summary?.length === 0 ? (
				<p className="text-[13px] text-text-3">No spend recorded.</p>
			) : (
				<div className="flex flex-col gap-1">
					{costs?.summary?.map((s) => (
						<div
							key={s.label}
							className="flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2 text-[13px]"
						>
							<span>{s.label}</span>
							<span className="font-mono">${(s.total_cents / 100).toFixed(2)}</span>
						</div>
					))}
					<div className="flex items-center justify-between px-3 py-2 text-[13px] font-medium border-t border-border mt-1 pt-2">
						<span>Total</span>
						<span className="font-mono">${((costs?.total_cents ?? 0) / 100).toFixed(2)}</span>
					</div>
				</div>
			)}
		</section>
	);
}

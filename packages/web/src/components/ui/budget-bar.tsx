interface BudgetBarProps {
	used: number;
	total: number;
	className?: string;
}

export function BudgetBar({ used, total, className = '' }: BudgetBarProps) {
	const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
	const fillColor = pct >= 90 ? 'bg-accent-red' : pct >= 70 ? 'bg-accent-amber' : 'bg-accent-green';

	return (
		<div className={`h-[3px] bg-bg-subtle rounded-sm overflow-hidden ${className}`}>
			<div className={`h-full rounded-sm ${fillColor}`} style={{ width: `${pct}%` }} />
		</div>
	);
}

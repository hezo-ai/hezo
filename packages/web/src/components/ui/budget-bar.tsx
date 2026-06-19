interface BudgetBarProps {
	used: number;
	total: number;
	className?: string;
}

// Threshold fill: success < 70% · warning 70–90% · danger ≥ 90%.
export function BudgetBar({ used, total, className = '' }: BudgetBarProps) {
	const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
	const fill = pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-success';

	return (
		<div className={`h-1.5 overflow-hidden rounded-full bg-surface-3 ${className}`}>
			<div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
		</div>
	);
}

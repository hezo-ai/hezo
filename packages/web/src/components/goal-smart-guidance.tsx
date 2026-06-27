import { GOAL_SMART_GUIDANCE } from '@hezo/shared';

/**
 * Compact SMART-goal reminder shown on the goal create/edit surfaces and the Goals page, so the
 * admin keeps the framework in mind while writing or editing a goal. Content comes from the
 * shared `GOAL_SMART_GUIDANCE` so every surface stays in sync.
 */
export function GoalSmartGuidance({ className = '' }: { className?: string }) {
	return (
		<div
			data-testid="goal-smart-guidance"
			className={`rounded-md border border-border bg-surface-2 p-3 ${className}`}
		>
			<p className="text-xs font-medium text-text-2 mb-2">
				Good goals are <span className="font-semibold text-text-1">SMART</span>:
			</p>
			<ul className="flex flex-col gap-1">
				{GOAL_SMART_GUIDANCE.map((item) => (
					<li key={item.letter} className="text-xs text-text-3 leading-relaxed">
						<span className="font-semibold text-text-2">
							{item.letter} — {item.label}:
						</span>{' '}
						{item.hint}
					</li>
				))}
			</ul>
		</div>
	);
}

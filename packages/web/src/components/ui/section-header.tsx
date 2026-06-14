import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Section heading with a leading icon, optional description, and an optional
 * right-aligned action (e.g. an Edit button). Shared across the budget surfaces
 * so headers line up the same way wherever budget UI is embedded.
 */
export function SectionHeader({
	icon: Icon,
	title,
	description,
	action,
}: {
	icon: LucideIcon;
	title: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<div className="mb-3 flex items-start justify-between gap-3">
			<div className="flex items-start gap-2">
				<Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-subtle" aria-hidden />
				<div>
					<h2 className="text-sm font-medium text-text">{title}</h2>
					{description && (
						<p className="mt-1 max-w-prose text-xs leading-relaxed text-text-subtle">
							{description}
						</p>
					)}
				</div>
			</div>
			{action && <div className="shrink-0">{action}</div>}
		</div>
	);
}

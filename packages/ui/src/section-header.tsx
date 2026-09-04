import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { type HeadingLevel, headingTag } from './heading.js';

export interface SectionHeaderProps {
	icon: LucideIcon;
	title: string;
	description?: string;
	action?: ReactNode;
	/** The heading rank this section sits at in the page's outline. */
	headingLevel?: HeadingLevel;
	className?: string;
}

/**
 * Section heading with a leading icon, optional description, and an optional
 * right-aligned action. One shape wherever a page divides into named sections,
 * so their headers line up rather than each surface inventing its own.
 */
export function SectionHeader({
	icon: Icon,
	title,
	description,
	action,
	headingLevel = 2,
	className = 'mb-3',
}: SectionHeaderProps) {
	const Heading = headingTag(headingLevel);
	return (
		<div className={`flex items-start justify-between gap-3 ${className}`}>
			<div className="flex items-start gap-2">
				<Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-3" aria-hidden />
				<div>
					<Heading className="text-sm font-medium text-text-1">{title}</Heading>
					{description && (
						<p className="mt-1 max-w-prose text-xs leading-relaxed text-text-3">{description}</p>
					)}
				</div>
			</div>
			{action && <div className="shrink-0">{action}</div>}
		</div>
	);
}

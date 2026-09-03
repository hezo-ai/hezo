import type { ReactNode } from 'react';
import { type HeadingLevel, headingTag } from './heading.js';

export interface EmptyStateProps {
	icon?: ReactNode;
	title: string;
	description?: string;
	action?: ReactNode;
	/** 'default' is a compact placeholder; 'hero' centers a larger CTA in the available height. */
	variant?: 'default' | 'hero';
	/** The heading rank this placeholder sits at in the page's outline. */
	headingLevel?: HeadingLevel;
}

export function EmptyState({
	icon,
	title,
	description,
	action,
	variant = 'default',
	headingLevel = 3,
}: EmptyStateProps) {
	const Heading = headingTag(headingLevel);
	if (variant === 'hero') {
		return (
			// `dvh`, not `vh`: on mobile the browser chrome is part of the viewport
			// height, so a `vh` box is taller than what anyone can actually see.
			<div className="flex items-center justify-center min-h-[60dvh] px-4 py-12 sm:py-16">
				<div className="flex flex-col items-center text-center gap-5 max-w-md">
					{icon && (
						<div className="w-16 h-16 rounded-full bg-surface flex items-center justify-center text-text-3">
							{icon}
						</div>
					)}
					<div className="flex flex-col gap-2">
						<Heading className="text-lg sm:text-xl font-semibold text-text-1">{title}</Heading>
						{description && (
							<p className="text-sm sm:text-[15px] text-text-2 leading-relaxed">{description}</p>
						)}
					</div>
					{action && <div className="mt-1">{action}</div>}
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
			{icon && <div className="text-text-3">{icon}</div>}
			<Heading className="text-sm font-medium text-text-1">{title}</Heading>
			{description && <p className="text-sm text-text-2 max-w-sm">{description}</p>}
			{action && <div className="mt-2">{action}</div>}
		</div>
	);
}

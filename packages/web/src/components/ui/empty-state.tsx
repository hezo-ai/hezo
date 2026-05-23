import type { ReactNode } from 'react';

interface EmptyStateProps {
	icon?: ReactNode;
	title: string;
	description?: string;
	action?: ReactNode;
	/** 'default' is a compact placeholder; 'hero' centers a larger CTA in the available height. */
	variant?: 'default' | 'hero';
}

export function EmptyState({
	icon,
	title,
	description,
	action,
	variant = 'default',
}: EmptyStateProps) {
	if (variant === 'hero') {
		return (
			<div className="flex items-center justify-center min-h-[60vh] px-4 py-12 sm:py-16">
				<div className="flex flex-col items-center text-center gap-5 max-w-md">
					{icon && (
						<div className="w-16 h-16 rounded-full bg-bg-elevated flex items-center justify-center text-text-subtle">
							{icon}
						</div>
					)}
					<div className="flex flex-col gap-2">
						<h3 className="text-lg sm:text-xl font-semibold text-text">{title}</h3>
						{description && (
							<p className="text-sm sm:text-[15px] text-text-muted leading-relaxed">
								{description}
							</p>
						)}
					</div>
					{action && <div className="mt-1">{action}</div>}
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
			{icon && <div className="text-text-subtle">{icon}</div>}
			<h3 className="text-sm font-medium text-text">{title}</h3>
			{description && <p className="text-sm text-text-muted max-w-sm">{description}</p>}
			{action && <div className="mt-2">{action}</div>}
		</div>
	);
}

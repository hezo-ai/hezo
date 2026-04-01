import type { ReactNode } from 'react';

interface EmptyStateProps {
	icon?: ReactNode;
	title: string;
	description?: string;
	action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
	return (
		<div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
			{icon && <div className="text-text-subtle">{icon}</div>}
			<h3 className="text-sm font-medium text-text">{title}</h3>
			{description && <p className="text-sm text-text-muted max-w-sm">{description}</p>}
			{action && <div className="mt-2">{action}</div>}
		</div>
	);
}

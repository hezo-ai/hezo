import type { ReactNode } from 'react';

export interface RelatedItem {
	key: string;
	label: ReactNode;
	/** When set, the row is a link to this href; otherwise it renders as plain text. */
	href?: string;
	title?: string;
	testId?: string;
}

/**
 * An indented, one-per-line list of items related to the row above it — the
 * connectors that use a credential, or the credentials a connector uses. Each
 * item is a deep-link (plain `<a href>`, matching the connector focus-link
 * pattern in connect-required-comment.tsx) or plain text when no href is given
 * (e.g. a credential shown to a non-superuser who can't open the credentials
 * page). Render only when there is something to show.
 */
export function RelatedItemsList({
	label,
	items,
	emptyLabel,
	testId,
}: {
	label?: string;
	items: RelatedItem[];
	emptyLabel?: ReactNode;
	testId?: string;
}) {
	return (
		<div className="mt-1 pl-4 border-l border-border flex flex-col gap-0.5" data-testid={testId}>
			{label && <span className="text-[11px] uppercase tracking-wide text-text-3">{label}</span>}
			{items.length === 0 ? (
				<span className="text-xs text-text-3">{emptyLabel ?? '—'}</span>
			) : (
				items.map((it) =>
					it.href ? (
						<a
							key={it.key}
							href={it.href}
							title={it.title}
							data-testid={it.testId}
							className="text-xs text-text-2 hover:text-text-1 underline decoration-dotted underline-offset-2 truncate w-fit max-w-full"
						>
							{it.label}
						</a>
					) : (
						<span
							key={it.key}
							title={it.title}
							data-testid={it.testId}
							className="text-xs text-text-2 truncate max-w-full"
						>
							{it.label}
						</span>
					),
				)
			)}
		</div>
	);
}

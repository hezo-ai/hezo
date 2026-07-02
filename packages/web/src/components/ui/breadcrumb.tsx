import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

export interface BreadcrumbSegment {
	key: string;
	label: ReactNode;
	/** Full text for the title attribute when the label is truncated. */
	title?: string;
	/** Navigation for non-leaf segments; the last segment never navigates. */
	onNavigate?: () => void;
}

/**
 * The task/goal-header breadcrumb idiom as a shared primitive: a mono 13px
 * row with ChevronRight separators and `aria-current="page"` on the leaf.
 * Non-leaf segments navigate via callback so callers can drive route params
 * or search params alike.
 */
export function Breadcrumb({
	segments,
	'data-testid': testId,
}: {
	segments: BreadcrumbSegment[];
	'data-testid'?: string;
}) {
	return (
		<nav
			aria-label="Breadcrumb"
			className="flex flex-wrap items-center gap-x-1 text-[13px] font-mono text-text-2"
			data-testid={testId}
		>
			{segments.map((seg, i) =>
				i < segments.length - 1 ? (
					<span key={seg.key} className="flex items-center gap-x-1">
						<button
							type="button"
							onClick={seg.onNavigate}
							className="cursor-pointer transition-colors hover:text-text-1 hover:underline"
							title={seg.title}
						>
							{seg.label}
						</button>
						<ChevronRight className="h-3 w-3 shrink-0 text-text-3" />
					</span>
				) : (
					<span key={seg.key} aria-current="page" className="text-text-1" title={seg.title}>
						{seg.label}
					</span>
				),
			)}
		</nav>
	);
}

import type { ThreadGroupSummary } from '@hezo/shared';
import { ChevronRight } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

interface EventGroupRowProps {
	summary: ThreadGroupSummary;
	expanded: boolean;
	onToggle: () => void;
	/** The folded rows, rendered beneath the chip while expanded. */
	children: React.ReactNode;
}

/**
 * A run of folded thread rows, shown as one chip in the position they happened.
 *
 * The chip says what is inside rather than only how much: a run of failures is
 * still legible as a shape without taking a screen to say so. Failures are
 * counted from each run's own status, so the number matches the rows the chip
 * hides however many of them there are.
 */
export function EventGroupRow({ summary, expanded, onToggle, children }: EventGroupRowProps) {
	const { t, plural } = useI18n();

	const parts: string[] = [];
	if (summary.failedRuns > 0) {
		parts.push(plural('thread.group.failedRuns', summary.failedRuns));
	}
	if (summary.runs > 0) parts.push(plural('thread.group.runs', summary.runs));
	if (summary.changes > 0) parts.push(plural('thread.group.changes', summary.changes));

	return (
		<div className="pb-4" data-testid="event-group">
			<div className="flex items-center gap-2.5">
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={expanded}
					data-testid="event-group-toggle"
					className="inline-flex min-w-0 shrink items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-0.5 text-[11.5px] text-text-2 transition-colors hover:bg-surface-2 hover:text-text-1 cursor-pointer"
				>
					<ChevronRight
						className={`w-3 h-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
						aria-hidden="true"
					/>
					{summary.failedRuns > 0 && (
						<span
							aria-hidden="true"
							className="inline-block w-2 h-2 shrink-0 rounded-full bg-danger"
							data-testid="event-group-failed-dot"
						/>
					)}
					<span className="whitespace-nowrap">{plural('thread.group.events', summary.total)}</span>
					{parts.length > 0 && (
						<span className="min-w-0 truncate text-text-3" data-testid="event-group-detail">
							{`· ${parts.join(' · ')}`}
						</span>
					)}
				</button>
				<span aria-hidden="true" className="h-px flex-1 bg-border" />
			</div>
			{expanded && (
				<div className="mt-3 ml-3 border-l border-border pl-3.5" data-testid="event-group-rows">
					{children}
				</div>
			)}
			{!expanded && <span className="sr-only">{t('thread.group.collapsedHint')}</span>}
		</div>
	);
}

import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useProjectProgress } from '../hooks/use-projects';
import { MarkdownProse } from './markdown-prose';

/** Collapsed height for the summary — just the bold lead line plus the first line of narrative. */
const COLLAPSED_MAX_HEIGHT = 64; // px

function formatUpdated(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
}

/**
 * The Captain-maintained project progress summary shown at the top of the Progress page. Collapsed
 * by default (showing the lead key points the Captain writes in bold), expandable to the full
 * narrative — mirroring how agent descriptions are shown. Renders null until a summary exists.
 */
export function ProjectProgressSummary({ projectId }: { projectId: string }) {
	const { data } = useProjectProgress(projectId);
	const [expanded, setExpanded] = useState(false);
	const [overflows, setOverflows] = useState(false);
	const contentRef = useRef<HTMLDivElement>(null);
	const contentId = useId();

	const summary = data?.summary?.trim() ?? '';
	const hasSummary = summary.length > 0;

	useLayoutEffect(() => {
		const el = contentRef.current;
		if (!el || !hasSummary) {
			setOverflows(false);
			return;
		}
		const measure = () => setOverflows(el.scrollHeight > COLLAPSED_MAX_HEIGHT + 1);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [hasSummary]);

	useEffect(() => {
		if (!overflows && expanded) setExpanded(false);
	}, [overflows, expanded]);

	if (!hasSummary) return null;

	return (
		<section
			data-testid="project-progress-summary"
			className="mb-6 rounded-md border border-border bg-surface p-4"
		>
			<div className="mb-2 flex items-center justify-between gap-2">
				<h2 className="text-[11px] font-medium uppercase tracking-wider text-text-3">
					Project progress
				</h2>
				{data?.updated_at && (
					<span className="text-[11px] text-text-3">Updated {formatUpdated(data.updated_at)}</span>
				)}
			</div>
			<div className="relative">
				<div
					ref={contentRef}
					id={contentId}
					className="overflow-hidden"
					style={expanded ? undefined : { maxHeight: COLLAPSED_MAX_HEIGHT }}
				>
					<MarkdownProse projectId={projectId} projectSlug={projectId}>
						{summary}
					</MarkdownProse>
				</div>
				{overflows && !expanded && (
					<div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-surface to-transparent" />
				)}
			</div>
			{overflows && (
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					aria-controls={contentId}
					data-testid="project-progress-toggle"
					className="mt-2 inline-flex items-center gap-1 text-xs text-text-2 hover:text-text-1"
				>
					{expanded ? 'Show less' : 'Show more'}
					<ChevronDown
						className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
					/>
				</button>
			)}
		</section>
	);
}

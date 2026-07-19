import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useProjectProgress } from '../hooks/use-projects';
import { MarkdownProse } from './markdown-prose';
import { HelpDialog } from './ui/help-dialog';
import { RelativeTime } from './ui/relative-time';

/**
 * Split the summary into its bold lead line (the key points the Captain leads with) and the rest
 * of the narrative. The lead is the first markdown paragraph — everything up to the first blank
 * line; the body is whatever follows. A summary with no blank line is all lead and has no body.
 */
function splitLead(summary: string): { lead: string; body: string } {
	const match = summary.match(/\n[ \t]*\n/);
	if (!match || match.index === undefined) return { lead: summary, body: '' };
	return {
		lead: summary.slice(0, match.index).trimEnd(),
		body: summary.slice(match.index + match[0].length).trim(),
	};
}

/** The explanation behind the question-mark help affordance on the Project progress header. */
function ProjectProgressHelp() {
	return (
		<HelpDialog
			title="About project progress"
			triggerLabel="About project progress"
			tooltip="What is project progress, and how does it update?"
			data-testid="project-progress-help"
		>
			<div className="flex flex-col gap-3 text-sm leading-relaxed text-text-2">
				<p>
					Project progress is the Captain's running summary of where this project stands. It leads
					with the key points in <span className="font-semibold">bold</span>, then a short narrative
					of what's done, in progress, and still to do. Collapsed, it shows just the bold lead line;
					use <span className="font-medium text-text-1">Show more</span> to read the full narrative.
				</p>
				<p>
					It updates on its own — there's nothing to edit by hand. Each time the Captain runs a
					progress-update heartbeat, it reviews progress across the project's goals and tasks and
					rewrites this summary. The <span className="font-medium text-text-1">Updated</span> time
					shows when it last changed.
				</p>
			</div>
		</HelpDialog>
	);
}

/**
 * The Captain-maintained project progress summary shown at the top of the Progress page. Collapsed
 * by default to just the bold lead line the Captain leads with, expandable to the full narrative —
 * mirroring how agent descriptions are shown. Renders null until a summary exists.
 */
export function ProjectProgressSummary({ projectId }: { projectId: string }) {
	const { data } = useProjectProgress(projectId);
	const [expanded, setExpanded] = useState(false);
	const contentId = useId();

	const summary = data?.summary?.trim() ?? '';
	const hasSummary = summary.length > 0;
	const { lead, body } = splitLead(summary);
	const hasBody = body.length > 0;

	// Collapse back down if the summary shrinks to a lead-only blurb while expanded.
	useEffect(() => {
		if (!hasBody && expanded) setExpanded(false);
	}, [hasBody, expanded]);

	if (!hasSummary) return null;

	return (
		<section
			data-testid="project-progress-summary"
			className="mb-6 rounded-md border border-border bg-surface p-4"
		>
			<div className="mb-2 flex items-center justify-between gap-2">
				<div className="flex items-center gap-1.5">
					<h2 className="text-[11px] font-medium uppercase tracking-wider text-text-3">
						Project progress
					</h2>
					<ProjectProgressHelp />
				</div>
				{data?.updated_at && (
					<span className="text-[11px] text-text-3">
						Updated <RelativeTime iso={data.updated_at} />
					</span>
				)}
			</div>
			<div id={contentId}>
				<MarkdownProse projectId={projectId} projectSlug={projectId}>
					{expanded ? summary : lead}
				</MarkdownProse>
			</div>
			{hasBody && (
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

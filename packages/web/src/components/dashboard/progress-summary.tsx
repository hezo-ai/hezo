import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useProjectProgress } from '../../hooks/use-projects';
import { useI18n } from '../../lib/i18n';
import { MarkdownProse } from '../markdown-prose';
import { HelpDialog } from '../ui/help-dialog';
import { RelativeTime } from '../ui/relative-time';

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

/** The explanation behind the question-mark help affordance on the progress header. */
function ProjectProgressHelp() {
	const { t } = useI18n();
	return (
		<HelpDialog
			title={t('progress.help.title')}
			triggerLabel={t('progress.help.title')}
			tooltip={t('progress.help.title')}
			data-testid="project-progress-help"
		>
			<div className="flex flex-col gap-3 text-sm leading-relaxed text-text-2">
				<p>{t('progress.help.summary')}</p>
				<p>{t('progress.help.updates')}</p>
			</div>
		</HelpDialog>
	);
}

/**
 * The Captain-maintained progress narrative, full width under the metric strip. It is the only
 * prose on the dashboard, which is why it gets the width rather than a rail: everything below it
 * is a list.
 *
 * Collapsed by default to the bold lead line and expandable to the full narrative, mirroring how
 * agent descriptions are shown. Collapsed is the default deliberately - a long summary would
 * otherwise push the action items below the fold, which is the one thing on the page that is
 * genuinely waiting on the reader.
 */
export function ProjectProgressSummary({ projectId }: { projectId: string }) {
	const { t } = useI18n();
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

	return (
		<section
			data-testid="project-progress-summary"
			className="rounded-lg border border-border bg-surface p-4"
		>
			<div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
				<div className="flex items-center gap-1.5">
					<h2 className="font-mono text-[10px] font-medium uppercase tracking-wider text-text-3">
						{t('progress.summary.heading')}
					</h2>
					<ProjectProgressHelp />
				</div>
				{data?.updated_at && (
					<span className="text-[11px] text-text-3">
						{t('progress.summary.updated')} <RelativeTime iso={data.updated_at} />
					</span>
				)}
			</div>
			{hasSummary ? (
				<div id={contentId} className="max-w-[80ch]">
					<MarkdownProse projectId={projectId} projectSlug={projectId}>
						{expanded ? summary : lead}
					</MarkdownProse>
				</div>
			) : (
				<p className="text-[13px] text-text-3" data-testid="project-progress-summary-empty">
					{t('progress.summary.empty')}
				</p>
			)}
			{hasBody && (
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					aria-controls={contentId}
					data-testid="project-progress-toggle"
					className="mt-2 inline-flex items-center gap-1 text-xs text-text-2 hover:text-text-1"
				>
					{expanded ? t('progress.summary.showLess') : t('progress.summary.showMore')}
					<ChevronDown
						className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
					/>
				</button>
			)}
		</section>
	);
}

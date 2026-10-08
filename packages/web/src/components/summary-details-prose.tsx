import { splitSummaryDetails } from '@hezo/shared';
import { ChevronDown } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { MarkdownProse, type MarkdownProseProps } from './markdown-prose';

/**
 * A toggle that starts collapsed and reveals a text's technical details. The
 * details mount only once opened, so a collapsed section costs no rendering.
 */
export function TechnicalDetailsDisclosure({ children }: { children: ReactNode }) {
	const { t } = useI18n();
	const [expanded, setExpanded] = useState(false);
	const detailsId = useId();
	return (
		<>
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				aria-controls={detailsId}
				data-testid="technical-details-toggle"
				className="mt-2 inline-flex max-w-full items-center gap-1 text-left text-xs text-text-2 hover:text-text-1"
			>
				{expanded ? t('markdown.technicalDetails.hide') : t('markdown.technicalDetails.show')}
				<ChevronDown
					className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
				/>
			</button>
			<div id={detailsId} hidden={!expanded} data-testid="technical-details">
				{expanded && <div className="mt-2 border-l-2 border-border pl-3">{children}</div>}
			</div>
		</>
	);
}

/**
 * Markdown written as a plain summary for people, optionally followed by a
 * technical-details section that agents read in full. The summary always shows;
 * the technical details sit behind a collapsed toggle. Text without the details
 * marker renders exactly as plain markdown prose.
 */
export function SummaryDetailsProse({ children, testId, ...proseProps }: MarkdownProseProps) {
	const { summary, details } = useMemo(() => splitSummaryDetails(children), [children]);

	if (details === null) {
		return (
			<MarkdownProse testId={testId} {...proseProps}>
				{children}
			</MarkdownProse>
		);
	}

	return (
		<div data-testid={testId}>
			{summary && <MarkdownProse {...proseProps}>{summary}</MarkdownProse>}
			<TechnicalDetailsDisclosure>
				<MarkdownProse {...proseProps}>{details}</MarkdownProse>
			</TechnicalDetailsDisclosure>
		</div>
	);
}

import { ArrowRight, History } from 'lucide-react';
import { formatDateTime, formatRelativeTime } from '../../lib/format-date';

interface ViewingRevisionBannerProps {
	revisionNumber: number;
	timestamp?: string;
	authorName?: string | null;
	onViewLatest: () => void;
}

/**
 * The bar shown above the metadata banner while viewing an older revision of a
 * document. "View latest" returns to the current version (where review comments
 * apply). Sits below the title/toolbar so the doc identity stays put.
 */
export function ViewingRevisionBanner({
	revisionNumber,
	timestamp,
	authorName,
	onViewLatest,
}: ViewingRevisionBannerProps) {
	const relative = timestamp ? formatRelativeTime(timestamp) : '';
	return (
		<div
			data-testid="viewing-revision-banner"
			className="mb-4 flex items-center gap-2 rounded-md bg-info/10 px-4 py-2 text-[13px] font-medium text-info"
		>
			<History className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
			<span className="min-w-0 truncate">
				<span className="font-semibold">You are viewing revision {revisionNumber}</span>
				{(relative || authorName) && (
					<span className="opacity-80">
						{' · '}
						{relative && timestamp && (
							<time dateTime={timestamp} title={formatDateTime(timestamp)}>
								created {relative}
							</time>
						)}
						{authorName && (
							<>
								{relative ? ' ' : ''}by {authorName}
							</>
						)}
					</span>
				)}
			</span>
			<button
				type="button"
				onClick={onViewLatest}
				data-testid="view-latest"
				className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-info/15"
			>
				View latest
				<ArrowRight className="w-3.5 h-3.5" />
			</button>
		</div>
	);
}

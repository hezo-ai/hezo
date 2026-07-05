import { Archive } from 'lucide-react';

/**
 * Neutral "Archived" chip for soft-deleted docs and assets. `overlay` renders
 * the media-corner variant (asset cards): a translucent surface with a border
 * so it stays legible over thumbnails.
 */
export function ArchivedBadge({ overlay = false }: { overlay?: boolean }) {
	return (
		<span
			data-testid="archived-badge"
			className={`inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] font-medium leading-4 ${
				overlay
					? 'border border-border-strong bg-surface/90 text-text-2 backdrop-blur-[2px]'
					: 'bg-neutral-soft text-neutral-soft-fg'
			}`}
		>
			<Archive className="h-2.5 w-2.5" />
			Archived
		</span>
	);
}

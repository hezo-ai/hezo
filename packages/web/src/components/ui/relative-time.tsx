import { useState } from 'react';
import {
	formatDateTime,
	formatRelativeTime,
	formatRelativeTimeCompact,
} from '../../lib/format-date';
import { Tooltip } from './tooltip';

/**
 * A timestamp rendered as a relative "X ago" label (or the absolute date once
 * it's older than a week, unless `alwaysRelative` is set), with the full local
 * date+time always reachable via a tooltip. On desktop the tooltip opens on
 * hover; on touch a tap toggles it (Radix tooltips never open on tap, so `open`
 * is driven manually — matching `CommentTimestampLink`).
 */
export function RelativeTime({
	iso,
	compact = false,
	alwaysRelative = false,
	className,
	side,
	testId,
}: {
	iso: string | null | undefined;
	/** Use the compact "5m"/"3h"/"2d" form instead of the full "5 minutes ago". */
	compact?: boolean;
	/** Stay relative past the week cutoff, for a slot whose point is the age. */
	alwaysRelative?: boolean;
	className?: string;
	side?: 'top' | 'right' | 'bottom' | 'left';
	testId?: string;
}) {
	const [open, setOpen] = useState(false);
	const label = compact
		? formatRelativeTimeCompact(iso, { alwaysRelative })
		: formatRelativeTime(iso, { alwaysRelative });
	if (!label) return null;
	return (
		<Tooltip content={formatDateTime(iso)} open={open} onOpenChange={setOpen} side={side}>
			<time
				dateTime={iso ?? undefined}
				onTouchStart={(e) => {
					e.preventDefault();
					setOpen((o) => !o);
				}}
				className={className}
				data-testid={testId}
			>
				{label}
			</time>
		</Tooltip>
	);
}

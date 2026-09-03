/**
 * A small pink count badge that overlays the top-right corner of an icon or
 * avatar — the at-a-glance "unread/outstanding" indicator used by the global
 * inbox icon and the per-project rail avatars. Renders nothing when the count
 * is zero. The parent element must establish a positioning context (`relative`).
 */
export interface CountOverlayBadgeProps {
	count: number;
	testId?: string;
}

export function CountOverlayBadge({ count, testId }: CountOverlayBadgeProps) {
	if (count <= 0) return null;
	return (
		<span
			data-testid={testId}
			className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-1 rounded-full bg-pink text-pink-fg text-[9px] leading-none font-medium flex items-center justify-center"
		>
			{count > 99 ? '99+' : count}
		</span>
	);
}

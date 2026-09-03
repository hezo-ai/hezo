import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

/**
 * Tooltips sit above dialog content but below nothing else the package draws.
 *
 * Named rather than written inline, for the same reason the dialog's two are:
 * the consumer owns its own stacking, and a number buried in a class string is
 * one it cannot see to override.
 */
export const TOOLTIP_Z = 'z-[95]';

export interface TooltipProviderProps {
	children: ReactNode;
	/** How long a pointer must rest before the first tooltip opens. */
	delayDuration?: number;
	/** How long afterwards a neighbouring tooltip opens with no delay at all. */
	skipDelayDuration?: number;
}

/**
 * Mounted once, near the root of the app.
 *
 * **Required, and deliberately not per tooltip.** The grouping that lets a
 * pointer move between adjacent tooltips without paying the delay again lives on
 * the provider, so one provider per tooltip is one group per tooltip - which is
 * no grouping at all.
 */
export function TooltipProvider({
	children,
	delayDuration = 150,
	skipDelayDuration,
}: TooltipProviderProps) {
	return (
		<TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration}>
			{children}
		</TooltipPrimitive.Provider>
	);
}

export interface TooltipProps {
	content: ReactNode;
	children: ReactNode;
	side?: 'top' | 'right' | 'bottom' | 'left';
	/** Overrides the provider's delay for this tooltip alone. */
	delayDuration?: number;
	/** Extra classes on the floating content panel (e.g. wider role-description tooltips). */
	contentClassName?: string;
	/**
	 * Controlled open state. Radix tooltips open on hover/focus but never on a
	 * touch tap; pass these to drive `open` yourself (e.g. toggle on click) so
	 * the tooltip also works on mobile.
	 */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

export function Tooltip({
	content,
	children,
	side = 'top',
	delayDuration,
	contentClassName,
	open,
	onOpenChange,
}: TooltipProps) {
	return (
		<TooltipPrimitive.Root open={open} onOpenChange={onOpenChange} delayDuration={delayDuration}>
			<TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Content
					side={side}
					sideOffset={6}
					className={`${TOOLTIP_Z} max-w-xs rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] leading-snug text-text-1 shadow-md ${contentClassName ?? ''}`}
				>
					{content}
					<TooltipPrimitive.Arrow className="fill-surface" />
				</TooltipPrimitive.Content>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}

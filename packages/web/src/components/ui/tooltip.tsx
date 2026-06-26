import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

interface TooltipProps {
	content: ReactNode;
	children: ReactNode;
	side?: 'top' | 'right' | 'bottom' | 'left';
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
	delayDuration = 150,
	contentClassName,
	open,
	onOpenChange,
}: TooltipProps) {
	return (
		<TooltipPrimitive.Provider delayDuration={delayDuration}>
			<TooltipPrimitive.Root open={open} onOpenChange={onOpenChange}>
				<TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
				<TooltipPrimitive.Portal>
					<TooltipPrimitive.Content
						side={side}
						sideOffset={6}
						className={`z-50 max-w-xs rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] leading-snug text-text-1 shadow-md data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 ${contentClassName ?? ''}`}
					>
						{content}
						<TooltipPrimitive.Arrow className="fill-surface" />
					</TooltipPrimitive.Content>
				</TooltipPrimitive.Portal>
			</TooltipPrimitive.Root>
		</TooltipPrimitive.Provider>
	);
}

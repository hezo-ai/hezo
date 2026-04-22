import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

interface TooltipProps {
	content: ReactNode;
	children: ReactNode;
	side?: 'top' | 'right' | 'bottom' | 'left';
	delayDuration?: number;
}

export function Tooltip({ content, children, side = 'top', delayDuration = 150 }: TooltipProps) {
	return (
		<TooltipPrimitive.Provider delayDuration={delayDuration}>
			<TooltipPrimitive.Root>
				<TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
				<TooltipPrimitive.Portal>
					<TooltipPrimitive.Content
						side={side}
						sideOffset={6}
						className="z-50 max-w-xs rounded-radius-md border border-border bg-bg-raised px-2.5 py-1.5 text-[11px] leading-snug text-text shadow-md data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0"
					>
						{content}
						<TooltipPrimitive.Arrow className="fill-bg-raised" />
					</TooltipPrimitive.Content>
				</TooltipPrimitive.Portal>
			</TooltipPrimitive.Root>
		</TooltipPrimitive.Provider>
	);
}

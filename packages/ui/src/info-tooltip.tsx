import { Info } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Tooltip } from './tooltip.js';

export interface InfoTooltipProps {
	content: ReactNode;
	label: string;
	side?: 'top' | 'right' | 'bottom' | 'left';
	className?: string;
	'data-testid'?: string;
}

/**
 * The trailing "what is this?" glyph beside a field or a heading.
 *
 * **It drives its own open state**, because a tooltip left uncontrolled opens on
 * hover and focus but never on a tap - and this trigger is the only route to
 * what it holds, so on a touch screen the content would be unreachable.
 */
export function InfoTooltip({
	content,
	label,
	side,
	className,
	'data-testid': testId,
}: InfoTooltipProps) {
	const [open, setOpen] = useState(false);
	return (
		<Tooltip content={content} side={side} open={open} onOpenChange={setOpen}>
			<button
				type="button"
				aria-label={label}
				aria-expanded={open}
				data-testid={testId}
				onClick={() => setOpen((v) => !v)}
				// The glyph stays 14px; the padding and the matching negative margin
				// give the finger something to hit without moving anything around it.
				className={`shrink-0 -m-1.5 p-1.5 text-text-3 hover:text-text-1 transition-colors ${className ?? ''}`}
			>
				<Info className="w-3.5 h-3.5" aria-hidden />
			</button>
		</Tooltip>
	);
}

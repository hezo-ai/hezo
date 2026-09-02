import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Tooltip } from './tooltip.js';

interface InfoTooltipProps {
	content: ReactNode;
	label: string;
	side?: 'top' | 'right' | 'bottom' | 'left';
	className?: string;
	'data-testid'?: string;
}

export function InfoTooltip({
	content,
	label,
	side,
	className,
	'data-testid': testId,
}: InfoTooltipProps) {
	return (
		<Tooltip content={content} side={side}>
			<button
				type="button"
				aria-label={label}
				data-testid={testId}
				className={`shrink-0 text-text-3 hover:text-text-1 transition-colors ${className ?? ''}`}
			>
				<Info className="w-3.5 h-3.5" />
			</button>
		</Tooltip>
	);
}

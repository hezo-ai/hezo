import * as Dialog from '@radix-ui/react-dialog';
import { HelpCircle } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { DialogContent, type DialogSize } from './dialog.js';
import { Tooltip } from './tooltip.js';

interface HelpDialogProps {
	/** Heading shown at the top of the modal. */
	title: ReactNode;
	/** Modal body content. */
	children: ReactNode;
	/** Accessible label for the question-mark trigger button. */
	triggerLabel: string;
	/**
	 * Optional hover/focus tooltip on the question-mark trigger — a one-line teaser
	 * shown before the user commits to opening the dialog. Omit for a bare trigger.
	 */
	tooltip?: ReactNode;
	/** Trigger button size class for the icon. Defaults to a small (3.5) glyph. */
	className?: string;
	/** Width of the modal. Defaults to `md`. */
	size?: DialogSize;
	/**
	 * The close button's accessible name, passed to the dialog body.
	 *
	 * **A prop with an English default, never a lookup.** A component holding a
	 * dialog has to forward the name, or the body falls back to English on a
	 * surface whose every other string is translated.
	 */
	closeLabel?: string;
	/**
	 * Trigger rendering: the default circled `HelpCircle` icon, or a bare "?"
	 * text glyph with no circle/border — for surfaces where the ring reads as
	 * visual noise (e.g. next to a floating toolbar).
	 */
	variant?: 'icon' | 'glyph';
	'data-testid'?: string;
}

/**
 * Reusable help affordance: a question-mark icon button that opens a modal popup with longer-form
 * guidance. Use this (rather than {@link InfoTooltip}) when the explanation is too rich for a hover
 * tooltip — the distinct `?` glyph signals to the user that clicking opens a dialog, not a tooltip.
 * Pass `tooltip` to also show a short hover teaser on the trigger.
 */
export function HelpDialog({
	title,
	children,
	triggerLabel,
	tooltip,
	className,
	size = 'md',
	variant = 'icon',
	closeLabel,
	'data-testid': testId,
}: HelpDialogProps) {
	const [open, setOpen] = useState(false);
	const trigger = (
		<Dialog.Trigger asChild>
			<button
				type="button"
				aria-label={triggerLabel}
				data-testid={testId}
				className={`shrink-0 text-text-3 hover:text-text-1 transition-colors ${className ?? ''}`}
			>
				{variant === 'glyph' ? (
					<span className="text-[15px] font-semibold leading-none" aria-hidden>
						?
					</span>
				) : (
					<HelpCircle className="w-3.5 h-3.5" />
				)}
			</button>
		</Dialog.Trigger>
	);
	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			{tooltip ? <Tooltip content={tooltip}>{trigger}</Tooltip> : trigger}
			<DialogContent size={size} closeLabel={closeLabel}>
				<Dialog.Title className="mb-4 pr-8 text-lg font-semibold">{title}</Dialog.Title>
				{children}
			</DialogContent>
		</Dialog.Root>
	);
}

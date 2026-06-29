import * as Dialog from '@radix-ui/react-dialog';
import { HelpCircle, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { dialogContentClassName, dialogOverlayClassName } from './dialog';

interface HelpDialogProps {
	/** Heading shown at the top of the modal. */
	title: ReactNode;
	/** Modal body content. */
	children: ReactNode;
	/** Accessible label for the question-mark trigger button. */
	triggerLabel: string;
	/** Trigger button size class for the icon. Defaults to a small (3.5) glyph. */
	className?: string;
	/** Width of the modal. Defaults to `md`. */
	size?: keyof typeof dialogContentClassName;
	'data-testid'?: string;
}

/**
 * Reusable help affordance: a question-mark icon button that opens a modal popup with longer-form
 * guidance. Use this (rather than {@link InfoTooltip}) when the explanation is too rich for a hover
 * tooltip — the distinct `?` glyph signals to the user that clicking opens a dialog, not a tooltip.
 */
export function HelpDialog({
	title,
	children,
	triggerLabel,
	className,
	size = 'md',
	'data-testid': testId,
}: HelpDialogProps) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Trigger asChild>
				<button
					type="button"
					aria-label={triggerLabel}
					data-testid={testId}
					className={`shrink-0 text-text-3 hover:text-text-1 transition-colors ${className ?? ''}`}
				>
					<HelpCircle className="w-3.5 h-3.5" />
				</button>
			</Dialog.Trigger>
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content className={dialogContentClassName[size]}>
					<div className="mb-4 flex items-center justify-between gap-2">
						<Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
						<Dialog.Close asChild>
							<button
								type="button"
								className="-m-2 p-2 text-text-2 hover:text-text-1"
								aria-label="Close"
							>
								<X className="h-4 w-4" />
							</button>
						</Dialog.Close>
					</div>
					{children}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

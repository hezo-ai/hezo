import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

// z-[90]/overlay z-[80] keep dialogs above the full-screen mobile surfaces that
// can host their triggers — the task-detail preview panel (z-[60]) and the review
// editor bottom sheet (z-[70]). At the lower z-50 the opaque preview panel painted
// over dialogs opened from its toolbar, so on mobile the dialog scroll-locked the
// page but was never visible. (In-dialog tooltips ride above at z-[95].)
const base =
	'fixed inset-0 z-[90] flex flex-col bg-surface p-4 overflow-y-auto outline-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-h-[90vh] sm:rounded-lg sm:border sm:border-border sm:p-6 sm:shadow-lg';

export const dialogContentClassName = {
	sm: `${base} sm:max-w-sm`,
	md: `${base} sm:max-w-md`,
	lg: `${base} sm:max-w-lg`,
	xl: `${base} sm:max-w-xl`,
	'2xl': `${base} sm:max-w-2xl`,
} as const;

export type DialogSize = keyof typeof dialogContentClassName;

/**
 * Fullscreen dialog content: fills the viewport (with a small inset on desktop)
 * instead of centring at a fixed max-width. `overflow-hidden` so an inner
 * `flex flex-col` body can own its own scrolling — used by dialogs that let a
 * field grow to fill the space (e.g. the create-task description).
 */
export const fullscreenContentClassName =
	'fixed inset-0 z-[90] flex flex-col bg-surface p-4 overflow-hidden outline-none sm:inset-4 sm:rounded-lg sm:border sm:border-border sm:p-6 sm:shadow-lg';

export const dialogOverlayClassName = 'fixed inset-0 bg-[var(--overlay)] backdrop-blur-sm z-[80]';

type DialogContentBaseProps = ComponentPropsWithoutRef<typeof Dialog.Content>;

interface DialogContentProps extends Omit<DialogContentBaseProps, 'className'> {
	/** Width preset. Ignored when `fullscreen` is set. Defaults to `md`. */
	size?: DialogSize;
	/** Fill the viewport (with a desktop inset) instead of centring at a preset width. */
	fullscreen?: boolean;
	/** Extra classes appended to the content box. */
	className?: string;
	/**
	 * Controls rendered inline to the left of the always-present close button, in the
	 * same top-right corner cluster (e.g. a fullscreen toggle). Rare — most dialogs
	 * put their actions in the body.
	 */
	cornerActions?: ReactNode;
	/**
	 * Hide the built-in close button. Only for dialogs that must force an explicit
	 * choice and provide their own dismissal (none today) — leaving it on is the
	 * default so every dialog is dismissable on touch, where there is no Escape key
	 * and the fullscreen content covers the (click-to-close) overlay.
	 */
	showClose?: boolean;
}

/**
 * Shared dialog body: wraps Radix `Portal` + `Overlay` + `Content` and renders a
 * close button in the top-right corner for **every** dialog. Centralising the
 * close affordance here is deliberate — on mobile the content fills the screen so
 * the overlay is not clickable and there is no Escape key, so a per-dialog "did we
 * remember a close button?" is a bug waiting to happen. Use this instead of hand-
 * rolling `Dialog.Portal`/`Overlay`/`Content`.
 *
 * Render `Dialog.Title`/`Dialog.Description` and the body as children:
 * ```tsx
 * <Dialog.Root open={open} onOpenChange={onOpenChange}>
 *   <DialogContent size="lg" data-testid="my-dialog">
 *     <Dialog.Title>…</Dialog.Title>
 *     …
 *   </DialogContent>
 * </Dialog.Root>
 * ```
 */
export function DialogContent({
	size = 'md',
	fullscreen = false,
	className,
	cornerActions,
	showClose = true,
	children,
	...props
}: DialogContentProps) {
	const contentClass = fullscreen ? fullscreenContentClassName : dialogContentClassName[size];
	return (
		<Dialog.Portal>
			<Dialog.Overlay className={dialogOverlayClassName} />
			<Dialog.Content
				className={className ? `${contentClass} ${className}` : contentClass}
				{...props}
			>
				{(showClose || cornerActions) && (
					<div className="absolute right-3 top-3 z-10 flex items-center gap-1 sm:right-4 sm:top-4">
						{cornerActions}
						{showClose && (
							<Dialog.Close asChild>
								<button
									type="button"
									className="-m-1 p-2 text-text-2 hover:text-text-1"
									aria-label="Close"
									data-testid="dialog-close"
								>
									<X className="h-4 w-4" />
								</button>
							</Dialog.Close>
						)}
					</div>
				)}
				{children}
			</Dialog.Content>
		</Dialog.Portal>
	);
}

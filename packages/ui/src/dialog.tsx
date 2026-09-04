import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { hitAreaClassName } from './density.js';

/**
 * Where a dialog sits, and what it has to clear.
 *
 * **The consumer owns its own stacking, so these are named rather than
 * scattered through the class strings.** They are set high enough to clear a
 * full-screen mobile surface that can host a dialog's trigger — in this app the
 * task-detail preview panel and the review editor bottom sheet. At a lower
 * value the opaque panel painted over dialogs opened from its own toolbar, so
 * on mobile the dialog scroll-locked the page and was never visible. An app
 * with taller layers passes its own `className`, which is appended last.
 */
export const OVERLAY_Z = 'z-[80]';
export const CONTENT_Z = 'z-[90]';

// dvh, not vh: on mobile `100vh` — and the containing block `inset-0` resolves
// against — is the LARGE viewport, i.e. the URL bar collapsed. With the bar
// expanded the box is laid out taller than the visual viewport, and because
// nothing then overflows, `overflow-y-auto` never engages and the bottom of the
// dialog is simply unreachable. dvh tracks the bar. The same hazard applies to
// any full-height app shell. The swap can only make a dialog shorter or equal,
// never taller, and every content box already scrolls.
const base = `fixed inset-0 ${CONTENT_Z} flex flex-col bg-surface p-4 max-h-dvh overflow-y-auto outline-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-h-[90dvh] sm:rounded-lg sm:border sm:border-border sm:p-6 sm:shadow-lg`;

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
export const fullscreenContentClassName = `fixed inset-0 ${CONTENT_Z} flex flex-col bg-surface p-4 overflow-hidden outline-none sm:inset-4 sm:rounded-lg sm:border sm:border-border sm:p-6 sm:shadow-lg`;

/**
 * **`bg-overlay`, never `bg-[var(--overlay)]`.** The utility reads the theme
 * key; the raw property is only defined where a stylesheet happens not to
 * namespace it, and where one does the backdrop is silently transparent with
 * nothing to see in the markup. Every consumer defines `--color-overlay`,
 * because that is what `@theme` publishes.
 */
export const dialogOverlayClassName = `fixed inset-0 bg-overlay backdrop-blur-sm ${OVERLAY_Z}`;

export type DialogContentBaseProps = ComponentPropsWithoutRef<typeof Dialog.Content>;

export interface DialogContentProps extends Omit<DialogContentBaseProps, 'className'> {
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
	/**
	 * The close button's accessible name.
	 *
	 * **A prop with an English default, never a lookup.** A primitive that
	 * resolved its own copy needed the app's translation context to render at
	 * all, which is what stopped this being shareable — for one word. An app
	 * with catalogs passes its own translation; one without gets English.
	 */
	closeLabel?: string;
	/**
	 * Whether the body renders a `Dialog.Description`.
	 *
	 * A dialog points at its description by id, so one that never renders it
	 * leaves the reference dangling. Say so instead, and the reference is dropped.
	 */
	described?: boolean;
}

/**
 * Shared dialog body: wraps Radix `Portal` + `Overlay` + `Content` and renders a
 * close button in the top-right corner for **every** dialog. Centralising the
 * close affordance here is deliberate — on mobile the content fills the screen so
 * the overlay is not clickable and there is no Escape key, so a per-dialog "did we
 * remember a close button?" is a bug waiting to happen. Use this instead of hand-
 * rolling `Dialog.Portal`/`Overlay`/`Content`.
 *
 * Render `Dialog.Title`/`Dialog.Description` and the body as children. A dialog
 * that renders a description says so, so the reference to it is kept:
 * ```tsx
 * <Dialog.Root open={open} onOpenChange={onOpenChange}>
 *   <DialogContent size="lg" described data-testid="my-dialog">
 *     <Dialog.Title>…</Dialog.Title>
 *     <Dialog.Description>…</Dialog.Description>
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
	closeLabel = 'Close',
	described = false,
	children,
	...props
}: DialogContentProps) {
	const contentClass = fullscreen ? fullscreenContentClassName : dialogContentClassName[size];
	return (
		<Dialog.Portal>
			<Dialog.Overlay className={dialogOverlayClassName} />
			<Dialog.Content
				className={className ? `${contentClass} ${className}` : contentClass}
				// Spread conditionally rather than written: passing the attribute at all
				// would override the id Radix wires to a description that does exist.
				{...(described ? {} : { 'aria-describedby': undefined })}
				{...props}
			>
				{(showClose || cornerActions) && (
					<div className="absolute right-3 top-3 z-10 flex items-center gap-1 sm:right-4 sm:top-4">
						{cornerActions}
						{showClose && (
							<Dialog.Close asChild>
								<button
									type="button"
									className={`relative -m-1 p-2 text-text-2 hover:text-text-1 ${hitAreaClassName}`}
									aria-label={closeLabel}
									data-testid="dialog-close"
								>
									<X className="h-4 w-4" aria-hidden />
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

import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Loader2, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { buttonClassName } from './button.js';
import { dialogContentClassName, dialogOverlayClassName } from './dialog.js';
import { kbdSizeClass, ShortcutKbd } from './shortcut-kbd.js';
import { ariaKeyshortcuts, isMacPlatform } from './shortcuts.js';
import { useShortcut } from './use-shortcut.js';

const CONFIRM_SHORTCUT = 'mod+Enter';

export interface ConfirmDialogProps {
	/**
	 * Extra content between the description and the buttons - a field the
	 * confirmation itself needs (a credential, a typed-name check). Optional: most
	 * confirmations are a question and two buttons.
	 */
	children?: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	/**
	 * What is about to happen, in a sentence.
	 *
	 * **Required.** A confirmation is an alert, and an alert with nothing but a
	 * heading is one a reader hears the question of but not the consequence.
	 */
	description: ReactNode;
	confirmLabel?: string;
	cancelLabel?: string;
	/**
	 * The close button's accessible name.
	 *
	 * **A prop with an English default, never a lookup.** A primitive that
	 * resolved its own copy needed the app's translation context to render at
	 * all, which is what stopped this being shareable — for two words. An app
	 * with catalogs passes its own translations; one without gets English.
	 */
	closeLabel?: string;
	/**
	 * What a reader is told when `onConfirm` rejects. Given the rejection, so a
	 * caller that can say something specific may.
	 */
	errorLabel?: (error: unknown) => ReactNode;
	variant?: 'default' | 'danger';
	onConfirm: () => void | Promise<void>;
	/** Called when `onConfirm` rejects, for a caller that reports failures itself. */
	onError?: (error: unknown) => void;
	loading?: boolean;
}

const confirmVariantClass = {
	default: 'primary',
	danger: 'destructive',
} as const;

export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel = 'Confirm',
	cancelLabel = 'Cancel',
	closeLabel = 'Close',
	errorLabel = () => 'Something went wrong. Please try again.',
	variant = 'default',
	onConfirm,
	onError,
	loading: externalLoading,
	children,
}: ConfirmDialogProps) {
	const [internalLoading, setInternalLoading] = useState(false);
	const [failure, setFailure] = useState<{ error: unknown } | null>(null);
	// `||`, not `??`: a caller wiring `loading={mutation.isPending}` passes `false`
	// until the request starts, and coalescing would pin the guard off for exactly
	// the window in which a second ⌘⏎ fires the action twice.
	const loading = Boolean(externalLoading) || internalLoading;
	const actionRef = useRef<HTMLButtonElement>(null);

	// The dialog stays mounted while closed, so a failure from a previous run has
	// to clear rather than greet whoever opens it next.
	useEffect(() => {
		if (open) setFailure(null);
	}, [open]);

	// ⌘/Ctrl+Enter confirms; Escape is handled natively by AlertDialog (the Esc
	// chip on Cancel is display-only). Gated on `open` since ConfirmDialog stays
	// mounted while closed.
	useShortcut(CONFIRM_SHORTCUT, () => actionRef.current?.click(), { enabled: open && !loading });

	async function handleConfirm(e: React.MouseEvent) {
		e.preventDefault();
		setInternalLoading(true);
		setFailure(null);
		try {
			await onConfirm();
			onOpenChange(false);
		} catch (err) {
			// Neither swallowed nor thrown into an event handler nobody can catch:
			// the dialog stays open with the failure on screen, so the reader can see
			// what happened and try again.
			setFailure({ error: err });
			onError?.(err);
		} finally {
			setInternalLoading(false);
		}
	}

	const isMac = isMacPlatform();

	return (
		<AlertDialog.Root open={open} onOpenChange={onOpenChange}>
			<AlertDialog.Portal>
				<AlertDialog.Overlay className={dialogOverlayClassName} />
				<AlertDialog.Content data-testid="confirm-dialog" className={dialogContentClassName.sm}>
					<AlertDialog.Cancel asChild>
						<button
							type="button"
							disabled={loading}
							className="absolute right-3 top-3 z-10 -m-1 p-2 text-text-2 hover:text-text-1 disabled:opacity-50 disabled:pointer-events-none sm:right-4 sm:top-4"
							aria-label={closeLabel}
							data-testid="confirm-dialog-close"
						>
							<X className="h-4 w-4" aria-hidden />
						</button>
					</AlertDialog.Cancel>
					<AlertDialog.Title className="text-base font-semibold mb-2">{title}</AlertDialog.Title>
					<AlertDialog.Description className="text-[13px] text-text-2 mb-5 leading-relaxed">
						{description}
					</AlertDialog.Description>
					{children && <div className="flex flex-col gap-2 mb-3">{children}</div>}
					{failure && (
						<p role="alert" className="text-[13px] text-danger mb-3 leading-relaxed">
							{errorLabel(failure.error)}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<AlertDialog.Cancel
							disabled={loading}
							aria-keyshortcuts={ariaKeyshortcuts('Escape', isMac)}
							className={buttonClassName({ variant: 'secondary', size: 'sm' })}
						>
							{cancelLabel}
							<ShortcutKbd shortcut="Escape" sizeClassName={kbdSizeClass.sm} />
						</AlertDialog.Cancel>
						<AlertDialog.Action
							ref={actionRef}
							data-testid="confirm-dialog-confirm"
							disabled={loading}
							onClick={handleConfirm}
							// The keycap is hidden from assistive tech, so the binding it
							// pictures is named here instead.
							aria-keyshortcuts={ariaKeyshortcuts(CONFIRM_SHORTCUT, isMac)}
							className={buttonClassName({ variant: confirmVariantClass[variant], size: 'sm' })}
						>
							{loading && <Loader2 className="w-3 h-3 animate-spin" aria-hidden />}
							{confirmLabel}
							<ShortcutKbd shortcut={CONFIRM_SHORTCUT} sizeClassName={kbdSizeClass.sm} />
						</AlertDialog.Action>
					</div>
				</AlertDialog.Content>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}

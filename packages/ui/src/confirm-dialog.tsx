import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Loader2, X } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { dialogContentClassName, dialogOverlayClassName } from './dialog.js';
import { kbdSizeClass, ShortcutKbd } from './shortcut-kbd.js';
import { useShortcut } from './use-shortcut.js';

interface ConfirmDialogProps {
	/**
	 * Extra content between the description and the buttons - a field the
	 * confirmation itself needs (a credential, a typed-name check). Optional: most
	 * confirmations are a question and two buttons.
	 */
	children?: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: React.ReactNode;
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
	variant?: 'default' | 'danger';
	onConfirm: () => void | Promise<void>;
	loading?: boolean;
}

const confirmVariantClass = {
	default: 'bg-inverse text-inverse-fg hover:opacity-85',
	danger: 'bg-danger text-danger-solid-fg hover:opacity-85',
} as const;

export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel = 'Confirm',
	cancelLabel = 'Cancel',
	closeLabel = 'Close',
	variant = 'default',
	onConfirm,
	loading: externalLoading,
	children,
}: ConfirmDialogProps) {
	const [internalLoading, setInternalLoading] = useState(false);
	const loading = externalLoading ?? internalLoading;
	const actionRef = useRef<HTMLButtonElement>(null);

	// ⌘/Ctrl+Enter confirms; Escape is handled natively by AlertDialog (the Esc
	// chip on Cancel is display-only). Gated on `open` since ConfirmDialog stays
	// mounted while closed.
	useShortcut('mod+Enter', () => actionRef.current?.click(), { enabled: open && !loading });

	async function handleConfirm(e: React.MouseEvent) {
		e.preventDefault();
		setInternalLoading(true);
		try {
			await onConfirm();
			onOpenChange(false);
		} finally {
			setInternalLoading(false);
		}
	}

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
							<X className="h-4 w-4" />
						</button>
					</AlertDialog.Cancel>
					<AlertDialog.Title className="text-base font-semibold mb-2">{title}</AlertDialog.Title>
					{description && (
						<AlertDialog.Description className="text-[13px] text-text-2 mb-5 leading-relaxed">
							{description}
						</AlertDialog.Description>
					)}
					{children && <div className="flex flex-col gap-2 mb-3">{children}</div>}
					<div className="flex justify-end gap-2">
						<AlertDialog.Cancel
							disabled={loading}
							aria-keyshortcuts="Escape"
							className="inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer bg-surface-2 text-text-2 border border-border hover:text-text-1 hover:bg-surface-3 px-2.5 py-1 text-xs rounded-md"
						>
							{cancelLabel}
							<ShortcutKbd shortcut="Escape" sizeClassName={kbdSizeClass.sm} />
						</AlertDialog.Cancel>
						<AlertDialog.Action
							ref={actionRef}
							data-testid="confirm-dialog-confirm"
							disabled={loading}
							onClick={handleConfirm}
							className={`inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer px-2.5 py-1 text-xs rounded-md ${confirmVariantClass[variant]}`}
						>
							{loading && <Loader2 className="w-3 h-3 animate-spin" />}
							{confirmLabel}
							<ShortcutKbd shortcut="mod+Enter" sizeClassName={kbdSizeClass.sm} />
						</AlertDialog.Action>
					</div>
				</AlertDialog.Content>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}

import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { dialogContentClassName, dialogOverlayClassName } from './dialog';

interface ConfirmDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: React.ReactNode;
	confirmLabel?: string;
	cancelLabel?: string;
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
	variant = 'default',
	onConfirm,
	loading: externalLoading,
}: ConfirmDialogProps) {
	const [internalLoading, setInternalLoading] = useState(false);
	const loading = externalLoading ?? internalLoading;

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
					<AlertDialog.Title className="text-base font-semibold mb-2">{title}</AlertDialog.Title>
					{description && (
						<AlertDialog.Description className="text-[13px] text-text-2 mb-5 leading-relaxed">
							{description}
						</AlertDialog.Description>
					)}
					<div className="flex justify-end gap-2">
						<AlertDialog.Cancel
							disabled={loading}
							className="inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer bg-surface-2 text-text-2 border border-border hover:text-text-1 hover:bg-surface-3 px-2.5 py-1 text-xs rounded-md"
						>
							{cancelLabel}
						</AlertDialog.Cancel>
						<AlertDialog.Action
							data-testid="confirm-dialog-confirm"
							disabled={loading}
							onClick={handleConfirm}
							className={`inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer px-2.5 py-1 text-xs rounded-md ${confirmVariantClass[variant]}`}
						>
							{loading && <Loader2 className="w-3 h-3 animate-spin" />}
							{confirmLabel}
						</AlertDialog.Action>
					</div>
				</AlertDialog.Content>
			</AlertDialog.Portal>
		</AlertDialog.Root>
	);
}

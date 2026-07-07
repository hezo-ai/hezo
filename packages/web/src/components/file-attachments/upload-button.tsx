import { Paperclip, Plus } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '../ui/button';

interface UploadButtonProps {
	/** Called with the picked files — route it to `useFileAttachments`' `handleFiles`. */
	onFiles: (files: File[]) => void;
	/** `accept` attribute for the picker (e.g. `ATTACHMENT_ACCEPT`). */
	accept?: string;
	label?: string;
	disabled?: boolean;
	/**
	 * Compact icon-only trigger (a paperclip) instead of the labelled "+ Upload"
	 * button — for tight composers like the realtime chatbox pill. `label` is used
	 * as the `aria-label`.
	 */
	iconOnly?: boolean;
	className?: string;
	'data-testid'?: string;
}

/**
 * A "+ Upload" button that opens the native file picker — the click-to-attach
 * alternative to drag-and-drop (and the primary affordance on touch devices,
 * which can't drag). Renders a hidden multi-select `<input type="file">` and
 * hands the chosen files back through `onFiles`. `type="button"` so it never
 * submits a surrounding form. Pass `iconOnly` for a compact paperclip trigger.
 */
export function UploadButton({
	onFiles,
	accept,
	label = 'Upload',
	disabled,
	iconOnly,
	className,
	'data-testid': testId,
}: UploadButtonProps) {
	const inputRef = useRef<HTMLInputElement>(null);

	return (
		<>
			{iconOnly ? (
				<button
					type="button"
					onClick={() => inputRef.current?.click()}
					disabled={disabled}
					aria-label={label}
					data-testid={testId}
					className={
						className ??
						'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-2 transition-colors hover:bg-surface-2 hover:text-text-1 disabled:opacity-40'
					}
				>
					<Paperclip className="h-4 w-4" />
				</button>
			) : (
				<Button
					type="button"
					variant="secondary"
					size="sm"
					onClick={() => inputRef.current?.click()}
					disabled={disabled}
					data-testid={testId}
				>
					<Plus className="h-3.5 w-3.5" />
					{label}
				</Button>
			)}
			<input
				ref={inputRef}
				type="file"
				multiple
				accept={accept}
				className="hidden"
				aria-hidden="true"
				tabIndex={-1}
				data-testid={testId ? `${testId}-input` : undefined}
				onChange={(e) => {
					const files = Array.from(e.target.files ?? []);
					if (files.length > 0) onFiles(files);
					// Reset so picking the same file again still fires `change`.
					e.target.value = '';
				}}
			/>
		</>
	);
}

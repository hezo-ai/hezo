import { Plus } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '../ui/button';

interface UploadButtonProps {
	/** Called with the picked files — route it to `useFileAttachments`' `handleFiles`. */
	onFiles: (files: File[]) => void;
	/** `accept` attribute for the picker (e.g. `ATTACHMENT_ACCEPT`). */
	accept?: string;
	label?: string;
	disabled?: boolean;
	'data-testid'?: string;
}

/**
 * A "+ Upload" button that opens the native file picker — the click-to-attach
 * alternative to drag-and-drop (and the primary affordance on touch devices,
 * which can't drag). Renders a hidden multi-select `<input type="file">` and
 * hands the chosen files back through `onFiles`. `type="button"` so it never
 * submits a surrounding form.
 */
export function UploadButton({
	onFiles,
	accept,
	label = 'Upload',
	disabled,
	'data-testid': testId,
}: UploadButtonProps) {
	const inputRef = useRef<HTMLInputElement>(null);

	return (
		<>
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

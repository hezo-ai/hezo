import { Upload } from 'lucide-react';
import type { ReactNode } from 'react';
import type { DropZoneHandlers } from '../../hooks/use-file-attachments';

interface FileDropZoneProps {
	/** From `useFileAttachments` — whether a file drag is currently over the zone. */
	isDragActive: boolean;
	/** From `useFileAttachments` — the four drag/drop handlers to spread on the zone. */
	dropZoneProps: DropZoneHandlers;
	overlayLabel?: string;
	overlayTestId?: string;
	className?: string;
	'data-testid'?: string;
	children: ReactNode;
}

/**
 * Reusable drag-and-drop surface: a relatively-positioned wrapper that wires the
 * drag handlers and paints a "drop to attach" overlay while a file is dragged
 * over it. Owns no state — feed it `isDragActive`/`dropZoneProps` from
 * `useFileAttachments`. The content it wraps (a textarea, a chat input, …) owns
 * keyboard interaction.
 */
export function FileDropZone({
	isDragActive,
	dropZoneProps,
	overlayLabel = 'Drop to attach',
	overlayTestId,
	className,
	'data-testid': testId,
	children,
}: FileDropZoneProps) {
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop wrapper; the wrapped input owns keyboard interaction
		<div
			className={`relative ${className ?? ''}`}
			data-testid={testId}
			onDragEnter={dropZoneProps.onDragEnter}
			onDragLeave={dropZoneProps.onDragLeave}
			onDragOver={dropZoneProps.onDragOver}
			onDrop={dropZoneProps.onDrop}
		>
			{children}
			{isDragActive && (
				<div
					className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-strong bg-surface/95"
					data-testid={overlayTestId}
				>
					<Upload className="h-5 w-5 text-text-3" />
					<p className="text-[13px] text-text-3">{overlayLabel}</p>
				</div>
			)}
		</div>
	);
}

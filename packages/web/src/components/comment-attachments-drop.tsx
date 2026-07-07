import type { ReactNode } from 'react';
import { useFileAttachments } from '../hooks/use-file-attachments';
import { useUploadAttachment } from '../hooks/use-upload-attachment';
import { ATTACHMENT_ACCEPT, AttachmentChips, FileDropZone, UploadButton } from './file-attachments';
import { InfoTooltip } from './ui/info-tooltip';

interface Props {
	projectId: string;
	taskId: string;
	value: string[];
	onChange: (ids: string[]) => void;
	children: ReactNode;
}

/**
 * Task-comment binding of the reusable file-attachment kit: wires the composer's
 * `pendingAttachmentIds` to `useFileAttachments` (uploading via the task assets
 * endpoint), wraps the comment textarea in a `FileDropZone`, and offers both an
 * **Upload** button and drag-and-drop. The drag hint is hidden on mobile, where
 * you can't drag — the Upload button is the affordance there. The generic parts
 * (`useFileAttachments`, `FileDropZone`, `UploadButton`, `AttachmentChips`) are
 * reused as-is by the realtime chat input.
 */
export function CommentAttachmentsDrop({ projectId, taskId, value, onChange, children }: Props) {
	const upload = useUploadAttachment(projectId, taskId);
	const {
		isDragActive,
		visibleAttachments,
		uploading,
		errors,
		hasAnyChip,
		handleFiles,
		removeAttachment,
		dropZoneProps,
	} = useFileAttachments({
		value,
		onChange,
		uploadFile: (file) => upload.mutateAsync(file),
	});

	return (
		<FileDropZone
			isDragActive={isDragActive}
			dropZoneProps={dropZoneProps}
			data-testid="comment-attachments-drop"
			overlayTestId="comment-attachment-drop-overlay"
		>
			<div className="mb-2 flex flex-wrap items-center gap-1.5">
				<UploadButton
					onFiles={handleFiles}
					accept={ATTACHMENT_ACCEPT}
					data-testid="comment-attachment-upload-button"
				/>
				{!hasAnyChip && (
					<div
						className="flex items-center gap-1.5 text-xs text-text-3"
						data-testid="comment-attachment-hint"
					>
						{/* Touch devices can't drag files, so the hint is desktop-only; the
						    Upload button carries attachment on mobile. */}
						<span className="hidden sm:inline" data-testid="comment-attachment-hint-text">
							Drag and drop files to attach
						</span>
						<InfoTooltip
							label="Supported attachment types"
							data-testid="comment-attachment-hint-info"
							content={
								<div className="space-y-1">
									<div>
										<strong>Images:</strong> PNG, JPG, GIF
									</div>
									<div>
										<strong>Documents:</strong> PDF, TXT
									</div>
									<div>
										<strong>Audio:</strong> MP3, WAV, AAC, OPUS
									</div>
									<div>
										<strong>Video:</strong> MP4, WEBM, MOV
									</div>
									<div className="pt-1 text-text-3">Max 10&nbsp;MB per file</div>
								</div>
							}
						/>
					</div>
				)}
			</div>
			{hasAnyChip && (
				<AttachmentChips
					attachments={visibleAttachments}
					uploading={uploading}
					errors={errors}
					onRemove={removeAttachment}
					rowTestId="comment-attachment-pending-row"
					chipTestId="comment-attachment-chip"
					previewTestId="comment-attachment-preview"
					errorTestId="comment-attachment-error"
				/>
			)}
			{children}
		</FileDropZone>
	);
}

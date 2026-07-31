import { ATTACHMENT_MAX_BYTES } from '@hezo/shared';
import type { ReactNode } from 'react';
import { useFileAttachments } from '../hooks/use-file-attachments';
import { useUploadAttachment } from '../hooks/use-upload-attachment';
import { useI18n } from '../lib/i18n';
import {
	ATTACHMENT_ACCEPT,
	ATTACHMENT_CATEGORIES,
	AttachmentChips,
	FileDropZone,
	formatCategoryExtensions,
	UploadButton,
} from './file-attachments';
import { InfoTooltip } from './ui/info-tooltip';

interface Props {
	projectId: string;
	taskId: string;
	value: string[];
	onChange: (ids: string[]) => void;
	/** Grow to fill a bounded flex column (used by the composer's fullscreen mode)
	 *  so the textarea below the fixed upload row + chips takes the remaining
	 *  height. Defaults to the natural, content-sized layout. */
	fill?: boolean;
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
export function CommentAttachmentsDrop({
	projectId,
	taskId,
	value,
	onChange,
	fill,
	children,
}: Props) {
	const { t } = useI18n();
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
			className={fill ? 'flex min-h-0 flex-1 flex-col' : undefined}
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
							{t('attachments.dragHint')}
						</span>
						<InfoTooltip
							label={t('attachments.supportedTypes')}
							data-testid="comment-attachment-hint-info"
							content={
								<div className="space-y-1">
									{/* Categories and their extension lists are derived from the
									    shared allowlist, so a new format needs no edit here. */}
									{ATTACHMENT_CATEGORIES.map((category) => (
										<div key={category.labelKey}>
											<strong>{t(category.labelKey)}</strong> {formatCategoryExtensions(category)}
										</div>
									))}
									<div className="pt-1 text-text-3">
										{t('attachments.maxSize', {
											size: `${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB`,
										})}
									</div>
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
					projectId={projectId}
					rowTestId="comment-attachment-pending-row"
					chipTestId="comment-attachment-chip"
					previewTestId="comment-attachment-preview"
					errorTestId="comment-attachment-error"
				/>
			)}
			{fill ? <div className="flex min-h-0 flex-1 flex-col">{children}</div> : children}
		</FileDropZone>
	);
}

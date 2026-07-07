import { assetBasename } from '@hezo/shared';
import {
	ExternalLink,
	FileAudio,
	File as FileIcon,
	FileText,
	FileVideo,
	Image as ImageIcon,
	Loader2,
	X,
} from 'lucide-react';
import type {
	ErrorChip,
	UploadedAttachment,
	UploadingFile,
} from '../../hooks/use-file-attachments';
import { Tooltip } from '../ui/tooltip';

function iconFor(contentType: string, className = 'h-3.5 w-3.5') {
	if (contentType.startsWith('image/')) return <ImageIcon className={className} />;
	if (contentType.startsWith('audio/')) return <FileAudio className={className} />;
	if (contentType.startsWith('video/')) return <FileVideo className={className} />;
	if (contentType === 'application/pdf' || contentType === 'text/plain') {
		return <FileText className={className} />;
	}
	return <FileIcon className={className} />;
}

interface AttachmentChipsProps {
	attachments: UploadedAttachment[];
	uploading: UploadingFile[];
	errors: ErrorChip[];
	onRemove: (id: string) => void;
	rowTestId?: string;
	chipTestId?: string;
	previewTestId?: string;
	errorTestId?: string;
}

/**
 * The pending-attachments row: a linked chip per uploaded file, a spinner chip
 * per in-flight upload, and a transient error chip per rejection. Presentational
 * only — the data comes from `useFileAttachments`.
 */
export function AttachmentChips({
	attachments,
	uploading,
	errors,
	onRemove,
	rowTestId,
	chipTestId,
	previewTestId,
	errorTestId,
}: AttachmentChipsProps) {
	return (
		<div className="mb-2 flex flex-wrap gap-1.5" data-testid={rowTestId}>
			{attachments.map((a) => (
				<span
					key={a.id}
					className="flex items-center gap-1.5 rounded-sm border border-border bg-surface-3 px-2 py-1 text-[12px] text-text-1"
					data-testid={chipTestId}
				>
					{iconFor(a.content_type)}
					<Tooltip content={a.original_filename}>
						<a
							href={a.url}
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-center gap-1 text-text-1 hover:underline"
							data-testid={previewTestId}
						>
							<span className="max-w-[140px] truncate">{assetBasename(a.original_filename)}</span>
							<ExternalLink className="h-3 w-3 shrink-0" />
						</a>
					</Tooltip>
					<button
						type="button"
						aria-label="Remove attachment"
						className="text-text-3 hover:text-text-1"
						onClick={() => onRemove(a.id)}
					>
						<X className="h-3 w-3" />
					</button>
				</span>
			))}
			{uploading.map((u) => (
				<span
					key={u.tempId}
					className="flex items-center gap-1.5 rounded-sm border border-dashed border-border bg-surface-3/50 px-2 py-1 text-[12px] text-text-3"
				>
					<Loader2 className="h-3 w-3 animate-spin" />
					<span className="max-w-[140px] truncate">{u.filename}</span>
				</span>
			))}
			{errors.map((e) => (
				<span
					key={e.id}
					className="flex items-center gap-1.5 rounded-sm border border-danger/40 bg-danger/10 px-2 py-1 text-[12px] text-danger"
					data-testid={errorTestId}
				>
					<span className="max-w-[200px] truncate">
						{e.filename}: {e.message}
					</span>
				</span>
			))}
		</div>
	);
}

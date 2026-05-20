import { ATTACHMENT_MAX_BYTES, isAllowedAttachmentExtension } from '@hezo/shared';
import {
	FileAudio,
	File as FileIcon,
	FileText,
	FileVideo,
	Image as ImageIcon,
	Loader2,
	Upload,
	X,
} from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import type { CommentAttachment } from '../hooks/use-comments';
import { useUploadAttachment } from '../hooks/use-upload-attachment';
import type { ApiError } from '../lib/api';

interface Props {
	teamId: string;
	issueId: string;
	value: string[];
	onChange: (ids: string[]) => void;
	children: ReactNode;
}

interface UploadingFile {
	tempId: string;
	filename: string;
}

interface ErrorChip {
	id: string;
	filename: string;
	message: string;
}

function iconFor(contentType: string, className = 'h-3.5 w-3.5') {
	if (contentType.startsWith('image/')) return <ImageIcon className={className} />;
	if (contentType.startsWith('audio/')) return <FileAudio className={className} />;
	if (contentType.startsWith('video/')) return <FileVideo className={className} />;
	if (contentType === 'application/pdf' || contentType === 'text/plain') {
		return <FileText className={className} />;
	}
	return <FileIcon className={className} />;
}

export function CommentAttachmentsDrop({ teamId, issueId, value, onChange, children }: Props) {
	const [isDragActive, setIsDragActive] = useState(false);
	const dragDepth = useRef(0);
	const [metaById, setMetaById] = useState<Map<string, CommentAttachment>>(new Map());
	const [uploading, setUploading] = useState<UploadingFile[]>([]);
	const [errors, setErrors] = useState<ErrorChip[]>([]);
	const upload = useUploadAttachment(teamId, issueId);

	const visibleAttachments = useMemo(
		() => value.map((id) => metaById.get(id)).filter((a): a is CommentAttachment => Boolean(a)),
		[value, metaById],
	);

	const pushError = useCallback((filename: string, message: string) => {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		setErrors((prev) => [...prev, { id, filename, message }]);
		setTimeout(() => setErrors((prev) => prev.filter((e) => e.id !== id)), 5000);
	}, []);

	const handleFiles = useCallback(
		async (files: File[]) => {
			const accepted: File[] = [];
			for (const file of files) {
				if (!isAllowedAttachmentExtension(file.name)) {
					pushError(file.name, 'Unsupported file type');
					continue;
				}
				if (file.size > ATTACHMENT_MAX_BYTES) {
					pushError(file.name, 'File exceeds 10 MB');
					continue;
				}
				accepted.push(file);
			}
			if (accepted.length === 0) return;

			const pending: UploadingFile[] = accepted.map((f) => ({
				tempId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
				filename: f.name,
			}));
			setUploading((prev) => [...prev, ...pending]);

			const results = await Promise.allSettled(accepted.map((file) => upload.mutateAsync(file)));

			const newOnes: CommentAttachment[] = [];
			results.forEach((res, idx) => {
				if (res.status === 'fulfilled') {
					newOnes.push(res.value);
				} else {
					const reason = res.reason as ApiError;
					pushError(accepted[idx].name, reason?.message ?? 'Upload failed');
				}
			});

			setUploading((prev) => prev.filter((u) => !pending.some((p) => p.tempId === u.tempId)));

			if (newOnes.length > 0) {
				setMetaById((prev) => {
					const next = new Map(prev);
					for (const a of newOnes) next.set(a.id, a);
					return next;
				});
				onChange([...value, ...newOnes.map((a) => a.id)]);
			}
		},
		[onChange, pushError, upload, value],
	);

	const onDragEnter = useCallback((e: React.DragEvent) => {
		if (!Array.from(e.dataTransfer.types).includes('Files')) return;
		e.preventDefault();
		dragDepth.current += 1;
		setIsDragActive(true);
	}, []);

	const onDragLeave = useCallback((e: React.DragEvent) => {
		if (!Array.from(e.dataTransfer.types).includes('Files')) return;
		e.preventDefault();
		dragDepth.current = Math.max(0, dragDepth.current - 1);
		if (dragDepth.current === 0) setIsDragActive(false);
	}, []);

	const onDragOver = useCallback((e: React.DragEvent) => {
		if (!Array.from(e.dataTransfer.types).includes('Files')) return;
		e.preventDefault();
	}, []);

	const onDrop = useCallback(
		(e: React.DragEvent) => {
			if (!Array.from(e.dataTransfer.types).includes('Files')) return;
			e.preventDefault();
			dragDepth.current = 0;
			setIsDragActive(false);
			const files = Array.from(e.dataTransfer.files);
			if (files.length > 0) handleFiles(files);
		},
		[handleFiles],
	);

	const removeAttachment = useCallback(
		(id: string) => {
			onChange(value.filter((v) => v !== id));
		},
		[onChange, value],
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop wrapper; the inner textarea owns keyboard interaction
		<div
			className="relative"
			data-testid="comment-attachments-drop"
			onDragEnter={onDragEnter}
			onDragLeave={onDragLeave}
			onDragOver={onDragOver}
			onDrop={onDrop}
		>
			{(visibleAttachments.length > 0 || uploading.length > 0 || errors.length > 0) && (
				<div className="mb-2 flex flex-wrap gap-1.5" data-testid="comment-attachment-pending-row">
					{visibleAttachments.map((a) => (
						<span
							key={a.id}
							className="flex items-center gap-1.5 rounded-radius-sm border border-border bg-bg-muted px-2 py-1 text-[12px] text-text"
							title={a.original_filename}
							data-testid="comment-attachment-chip"
						>
							{iconFor(a.content_type)}
							<span className="max-w-[140px] truncate">{a.original_filename}</span>
							<button
								type="button"
								aria-label="Remove attachment"
								className="text-text-subtle hover:text-text"
								onClick={() => removeAttachment(a.id)}
							>
								<X className="h-3 w-3" />
							</button>
						</span>
					))}
					{uploading.map((u) => (
						<span
							key={u.tempId}
							className="flex items-center gap-1.5 rounded-radius-sm border border-dashed border-border bg-bg-muted/50 px-2 py-1 text-[12px] text-text-subtle"
						>
							<Loader2 className="h-3 w-3 animate-spin" />
							<span className="max-w-[140px] truncate">{u.filename}</span>
						</span>
					))}
					{errors.map((e) => (
						<span
							key={e.id}
							className="flex items-center gap-1.5 rounded-radius-sm border border-danger/40 bg-danger/10 px-2 py-1 text-[12px] text-danger"
							data-testid="comment-attachment-error"
						>
							<span className="max-w-[200px] truncate">
								{e.filename}: {e.message}
							</span>
						</span>
					))}
				</div>
			)}
			{children}
			{isDragActive && (
				<div
					className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-radius-md border border-dashed border-border-hover bg-bg-elevated/95"
					data-testid="comment-attachment-drop-overlay"
				>
					<Upload className="h-5 w-5 text-text-subtle" />
					<p className="text-[13px] text-text-subtle">Drop to attach</p>
				</div>
			)}
		</div>
	);
}

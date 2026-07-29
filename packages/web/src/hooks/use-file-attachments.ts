import { ATTACHMENT_MAX_BYTES, isAllowedAttachmentExtension } from '@hezo/shared';
import { type DragEventHandler, useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Minimal shape the attachments UI needs from an uploaded file. Any upload
 * mutation whose result carries these fields (the task `CommentAttachment`, and
 * the realtime-chat attachment to come) satisfies it.
 */
export interface UploadedAttachment {
	id: string;
	content_type: string;
	original_filename: string;
	url: string;
}

export interface UploadingFile {
	tempId: string;
	filename: string;
}

export interface ErrorChip {
	id: string;
	filename: string;
	message: string;
}

/** How long a validation-error chip stays on screen before auto-dismissing. */
const ERROR_CHIP_TTL_MS = 5000;

export interface DropZoneHandlers {
	onDragEnter: DragEventHandler;
	onDragLeave: DragEventHandler;
	onDragOver: DragEventHandler;
	onDrop: DragEventHandler;
}

interface UseFileAttachmentsOptions<T extends UploadedAttachment> {
	/** Selected attachment ids (controlled by the consumer). */
	value: string[];
	onChange: (ids: string[]) => void;
	/** Uploads one file and resolves to its stored metadata. Injected so this hook
	 *  stays decoupled from any one endpoint (comments today, chat later). */
	uploadFile: (file: File) => Promise<T>;
}

/**
 * Headless state machine behind the file-attachment UI: client-side validation
 * (extension + 10 MB cap), concurrent uploads with per-file progress, transient
 * error chips, a depth-tracked drag overlay, and add/remove of the selected ids.
 * It renders nothing — pair it with `FileDropZone`, `UploadButton`, and
 * `AttachmentChips`, or drive `handleFiles`/`dropZoneProps` from any surface.
 */
export function useFileAttachments<T extends UploadedAttachment>({
	value,
	onChange,
	uploadFile,
}: UseFileAttachmentsOptions<T>) {
	const [isDragActive, setIsDragActive] = useState(false);
	const dragDepth = useRef(0);
	const [metaById, setMetaById] = useState<Map<string, T>>(new Map());
	const [uploading, setUploading] = useState<UploadingFile[]>([]);
	const [errors, setErrors] = useState<ErrorChip[]>([]);

	const visibleAttachments = useMemo(
		() => value.map((id) => metaById.get(id)).filter((a): a is T => Boolean(a)),
		[value, metaById],
	);

	// Pending auto-dismiss timers for the error chips, cleared on unmount. An
	// untracked timer outlives the component and fires setState on it 5s later —
	// harmless-looking in the browser, but under a test runner the DOM
	// environment is gone by then and React throws "window is not defined" as an
	// unhandled exception that fails the whole file.
	const errorTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
	useEffect(() => {
		const timers = errorTimers.current;
		return () => {
			for (const t of timers) clearTimeout(t);
			timers.clear();
		};
	}, []);

	const pushError = useCallback((filename: string, message: string) => {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		setErrors((prev) => [...prev, { id, filename, message }]);
		const timer = setTimeout(() => {
			errorTimers.current.delete(timer);
			setErrors((prev) => prev.filter((e) => e.id !== id));
		}, ERROR_CHIP_TTL_MS);
		errorTimers.current.add(timer);
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

			const results = await Promise.allSettled(accepted.map((file) => uploadFile(file)));

			const newOnes: T[] = [];
			results.forEach((res, idx) => {
				if (res.status === 'fulfilled') {
					newOnes.push(res.value);
				} else {
					const message = res.reason instanceof Error ? res.reason.message : 'Upload failed';
					pushError(accepted[idx].name, message);
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
		[onChange, pushError, uploadFile, value],
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

	const hasAnyChip = visibleAttachments.length > 0 || uploading.length > 0 || errors.length > 0;

	const dropZoneProps: DropZoneHandlers = { onDragEnter, onDragLeave, onDragOver, onDrop };

	return {
		isDragActive,
		visibleAttachments,
		uploading,
		errors,
		hasAnyChip,
		handleFiles,
		removeAttachment,
		dropZoneProps,
	};
}

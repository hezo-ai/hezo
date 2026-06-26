import { isMarkdownAssetMime } from '@hezo/shared';
import { createFileRoute } from '@tanstack/react-router';
import {
	Code,
	ExternalLink,
	FileAudio,
	File as FileIcon,
	FileText,
	FileVideo,
	Image as ImageIcon,
	Loader2,
	Trash2,
	Upload,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownAssetDialog } from '../../../components/markdown-asset-dialog';
import { Button } from '../../../components/ui/button';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { EmptyState } from '../../../components/ui/empty-state';
import {
	type ProjectAsset,
	useDeleteProjectAsset,
	useProjectAssets,
	useUploadProjectAsset,
} from '../../../hooks/use-project-assets';
import type { ApiError } from '../../../lib/api';

interface AssetsSearch {
	file?: string;
}

interface ErrorChip {
	id: string;
	filename: string;
	message: string;
}

function AssetIcon({ contentType }: { contentType: string }) {
	const cls = 'h-8 w-8 text-text-3';
	if (contentType.startsWith('audio/')) return <FileAudio className={cls} />;
	if (contentType.startsWith('video/')) return <FileVideo className={cls} />;
	if (contentType === 'text/html') return <Code className={cls} />;
	if (
		contentType === 'application/pdf' ||
		contentType === 'text/plain' ||
		isMarkdownAssetMime(contentType)
	) {
		return <FileText className={cls} />;
	}
	if (contentType.startsWith('image/')) return <ImageIcon className={cls} />;
	return <FileIcon className={cls} />;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ProjectAssetsPage() {
	const { projectId } = Route.useParams();
	const { file: focusFile } = Route.useSearch();
	const { data: assets, isLoading } = useProjectAssets(projectId);
	const upload = useUploadProjectAsset(projectId);
	const del = useDeleteProjectAsset(projectId);

	const inputRef = useRef<HTMLInputElement>(null);
	const [isDragActive, setIsDragActive] = useState(false);
	const dragDepth = useRef(0);
	const [errors, setErrors] = useState<ErrorChip[]>([]);
	const [pendingDelete, setPendingDelete] = useState<ProjectAsset | null>(null);
	const [viewMarkdown, setViewMarkdown] = useState<ProjectAsset | null>(null);

	const pushError = useCallback((filename: string, message: string) => {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		setErrors((prev) => [...prev, { id, filename, message }]);
		setTimeout(() => setErrors((prev) => prev.filter((e) => e.id !== id)), 5000);
	}, []);

	const handleFiles = useCallback(
		async (files: File[]) => {
			for (const file of files) {
				try {
					await upload.mutateAsync(file);
				} catch (e) {
					pushError(file.name, (e as ApiError)?.message ?? 'Upload failed');
				}
			}
		},
		[upload, pushError],
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

	const deleteCount = pendingDelete?.comment_attachment_count ?? 0;

	return (
		<div>
			<div className="flex flex-wrap items-start justify-between gap-2 mb-4">
				<div className="min-w-0">
					<h1 className="text-base font-semibold text-text-1">Assets</h1>
					<p className="text-[13px] text-text-2">
						Mockups, wireframes, and other uploads. Reference one in a comment or doc as{' '}
						<code className="text-info-soft-fg">assets/&lt;filename&gt;</code>.
					</p>
				</div>
				<Button
					size="sm"
					onClick={() => inputRef.current?.click()}
					disabled={upload.isPending}
					data-testid="asset-upload-button"
				>
					{upload.isPending ? (
						<Loader2 className="w-3.5 h-3.5 animate-spin" />
					) : (
						<Upload className="w-3.5 h-3.5" />
					)}
					Upload
				</Button>
				<input
					ref={inputRef}
					type="file"
					multiple
					className="hidden"
					data-testid="asset-file-input"
					onChange={(e) => {
						const files = Array.from(e.target.files ?? []);
						if (files.length > 0) handleFiles(files);
						e.target.value = '';
					}}
				/>
			</div>

			{errors.length > 0 && (
				<div className="mb-3 flex flex-wrap gap-1.5">
					{errors.map((e) => (
						<span
							key={e.id}
							className="rounded-sm border border-danger/40 bg-danger/10 px-2 py-1 text-[12px] text-danger"
							data-testid="asset-upload-error"
						>
							{e.filename}: {e.message}
						</span>
					))}
				</div>
			)}

			{/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop upload zone; uploads also work via the Upload button */}
			<div
				className="relative min-h-[300px]"
				data-testid="asset-drop-zone"
				onDragEnter={onDragEnter}
				onDragLeave={onDragLeave}
				onDragOver={onDragOver}
				onDrop={onDrop}
			>
				{isLoading ? (
					<div className="text-text-2 text-[13px] py-4">Loading...</div>
				) : !assets || assets.length === 0 ? (
					<EmptyState
						icon={<ImageIcon className="w-10 h-10" />}
						title="No assets yet"
						description="Drag files here or use Upload to add mockups, wireframes, and other files."
					/>
				) : (
					<ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
						{assets.map((asset) => (
							<AssetCard
								key={asset.id}
								asset={asset}
								highlighted={focusFile === asset.original_filename}
								onDelete={() => setPendingDelete(asset)}
								onView={() => setViewMarkdown(asset)}
							/>
						))}
					</ul>
				)}

				{isDragActive && (
					<div
						className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-strong bg-surface/95"
						data-testid="asset-drop-overlay"
					>
						<Upload className="h-5 w-5 text-text-3" />
						<p className="text-[13px] text-text-3">Drop to upload</p>
					</div>
				)}
			</div>

			<ConfirmDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) setPendingDelete(null);
				}}
				title="Delete this asset?"
				description={
					deleteCount > 0
						? `This file is attached to ${deleteCount} comment${
								deleteCount === 1 ? '' : 's'
							} and will be removed from ${
								deleteCount === 1 ? 'it' : 'them'
							}. This cannot be undone.`
						: 'The file will be permanently removed. This cannot be undone.'
				}
				confirmLabel="Delete"
				variant="danger"
				onConfirm={async () => {
					if (!pendingDelete) return;
					try {
						await del.mutateAsync(pendingDelete.id);
					} catch (e) {
						pushError(pendingDelete.original_filename, (e as ApiError)?.message ?? 'Delete failed');
					}
					setPendingDelete(null);
				}}
			/>

			{viewMarkdown && (
				<MarkdownAssetDialog
					asset={viewMarkdown}
					projectId={projectId}
					open={viewMarkdown !== null}
					onOpenChange={(open) => {
						if (!open) setViewMarkdown(null);
					}}
				/>
			)}
		</div>
	);
}

function AssetCard({
	asset,
	highlighted,
	onDelete,
	onView,
}: {
	asset: ProjectAsset;
	highlighted: boolean;
	onDelete: () => void;
	onView: () => void;
}) {
	const ref = useRef<HTMLLIElement>(null);
	useEffect(() => {
		if (highlighted) ref.current?.scrollIntoView({ block: 'center' });
	}, [highlighted]);

	const isImage = asset.content_type.startsWith('image/');
	const isHtml = asset.content_type === 'text/html';
	const isMarkdown = isMarkdownAssetMime(asset.content_type);
	const thumbnail = isImage ? (
		<img src={asset.url} alt={asset.original_filename} className="h-full w-full object-cover" />
	) : isHtml ? (
		<iframe
			src={asset.url}
			title={asset.original_filename}
			sandbox=""
			className="pointer-events-none h-full w-full bg-surface"
		/>
	) : (
		<AssetIcon contentType={asset.content_type} />
	);
	return (
		<li
			ref={ref}
			data-testid="asset-card"
			data-filename={asset.original_filename}
			className={`flex flex-col overflow-hidden rounded-md border bg-surface-2 ${
				highlighted ? 'border-info' : 'border-border'
			}`}
		>
			{/* Markdown renders in-app (rich preview + view-source); everything else
			    opens its raw signed URL in a new tab. */}
			{isMarkdown ? (
				<button
					type="button"
					onClick={onView}
					className="flex h-28 items-center justify-center bg-surface-3"
					data-testid="asset-open-markdown"
					aria-label={`View ${asset.original_filename}`}
				>
					{thumbnail}
				</button>
			) : (
				<a
					href={asset.url}
					target="_blank"
					rel="noopener noreferrer"
					className="flex h-28 items-center justify-center bg-surface-3"
					data-testid="asset-open-link"
					aria-label={`Open ${asset.original_filename} in a new tab`}
				>
					{thumbnail}
				</a>
			)}
			<div className="flex items-start justify-between gap-1 p-2">
				<div className="min-w-0">
					<div
						className="truncate text-[12px] font-medium text-text-1"
						title={asset.original_filename}
					>
						{asset.original_filename}
					</div>
					<div className="text-[11px] text-text-3">{formatBytes(asset.byte_size)}</div>
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					<a
						href={asset.url}
						target="_blank"
						rel="noopener noreferrer"
						className="p-1 text-text-3 hover:text-text-1"
						aria-label="Open in new tab"
						data-testid="asset-popout"
					>
						<ExternalLink className="h-3.5 w-3.5" />
					</a>
					<button
						type="button"
						className="p-1 text-text-3 hover:text-danger"
						onClick={onDelete}
						aria-label="Delete asset"
						data-testid="asset-delete"
					>
						<Trash2 className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>
		</li>
	);
}

export const Route = createFileRoute('/projects/$projectId/assets')({
	validateSearch: (search: Record<string, unknown>): AssetsSearch => ({
		file: typeof search.file === 'string' ? search.file : undefined,
	}),
	// HQ (the internal coordination project) exposes Assets too: it's where the
	// CEO saves files it produces for the operator in chat (write_project_asset),
	// so `assets/<filename>` references in the chat resolve to a real page.
	component: ProjectAssetsPage,
});

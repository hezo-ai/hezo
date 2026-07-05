import {
	ArchiveFilter,
	ASSET_MAX_FOLDER_DEPTH,
	assetBasename,
	assetFolder,
	isArchiveFilter,
	isMarkdownAssetMime,
	matchesArchiveFilter,
	normalizeAssetFolder,
} from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { createFileRoute } from '@tanstack/react-router';
import {
	Archive,
	ArchiveRestore,
	Check,
	ChevronDown,
	Code,
	Copy,
	ExternalLink,
	FileAudio,
	File as FileIcon,
	FileText,
	FileVideo,
	Filter,
	Folder,
	FolderInput,
	FolderPlus,
	Image as ImageIcon,
	Loader2,
	Search,
	Trash2,
	Upload,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownAssetDialog } from '../../../components/markdown-asset-dialog';
import { ArchivedBadge } from '../../../components/ui/archived-badge';
import { Breadcrumb, type BreadcrumbSegment } from '../../../components/ui/breadcrumb';
import { Button } from '../../../components/ui/button';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { DialogContent } from '../../../components/ui/dialog';
import { EmptyState } from '../../../components/ui/empty-state';
import { Input } from '../../../components/ui/input';
import { Tooltip } from '../../../components/ui/tooltip';
import {
	type ProjectAsset,
	useArchiveProjectAsset,
	useDeleteProjectAsset,
	useMoveProjectAsset,
	useProjectAssets,
	useUploadProjectAsset,
} from '../../../hooks/use-project-assets';
import type { ApiError } from '../../../lib/api';
import {
	allFolders,
	filterFolderTree,
	folderCrumbs,
	folderIndentLevel,
	folderLeafName,
	groupAssets,
} from '../../../lib/asset-folders';
import { copyToClipboard } from '../../../lib/clipboard';

interface AssetsSearch {
	file?: string;
	folder?: string;
	/** Archive filter — absent means the default Active view. */
	filter?: ArchiveFilter;
}

const FILTER_TEXT: Record<ArchiveFilter, string> = {
	[ArchiveFilter.Active]: 'Showing active items',
	[ArchiveFilter.Archived]: 'Showing archived items',
	[ArchiveFilter.All]: 'Showing all items',
};

/**
 * "Showing … items" caption + funnel button; the button opens a small popover
 * listing the three archive-filter views with live counts.
 */
function AssetFilterControl({
	filter,
	counts,
	onChange,
}: {
	filter: ArchiveFilter;
	counts: Record<ArchiveFilter, number>;
	onChange: (next: ArchiveFilter) => void;
}) {
	const [open, setOpen] = useState(false);
	const options = [
		{ value: ArchiveFilter.Active, label: 'Active' },
		{ value: ArchiveFilter.Archived, label: 'Archived' },
		{ value: ArchiveFilter.All, label: 'All' },
	];
	return (
		<div className="mb-3 flex items-center gap-1.5">
			<span className="text-[12.5px] text-text-2" data-testid="asset-filter-text">
				{FILTER_TEXT[filter]}
			</span>
			<Popover.Root open={open} onOpenChange={setOpen}>
				<Popover.Trigger asChild>
					<button
						type="button"
						aria-label="Filter assets"
						data-testid="asset-filter-button"
						className={`inline-flex items-center rounded-md border p-1.5 transition-colors cursor-pointer ${
							filter === ArchiveFilter.Active
								? 'border-border bg-surface text-text-2 hover:border-border-strong hover:text-text-1'
								: 'border-border-strong bg-surface-2 text-text-1'
						}`}
					>
						<Filter className="h-3.5 w-3.5" />
					</button>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						align="start"
						sideOffset={4}
						className="z-50 min-w-[180px] rounded-md border border-border bg-surface p-1 shadow-md"
						data-testid="asset-filter-popover"
					>
						{options.map((opt) => {
							const selected = filter === opt.value;
							return (
								<button
									key={opt.value}
									type="button"
									role="menuitemradio"
									aria-checked={selected}
									data-testid={`asset-filter-option-${opt.value}`}
									onClick={() => {
										onChange(opt.value);
										setOpen(false);
									}}
									className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors cursor-pointer text-left ${
										selected
											? 'bg-surface-2 text-text-1'
											: 'text-text-2 hover:bg-surface-3 hover:text-text-1'
									}`}
								>
									<span className="flex-1">{opt.label}</span>
									<span className="font-mono text-[11px] text-text-3">{counts[opt.value]}</span>
									{selected && <Check className="h-3.5 w-3.5 shrink-0 text-info" />}
								</button>
							);
						})}
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
		</div>
	);
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
	const { file: focusFile, folder: folderParam, filter = ArchiveFilter.Active } = Route.useSearch();
	const navigate = Route.useNavigate();
	const { data: assets, isLoading } = useProjectAssets(projectId);
	const upload = useUploadProjectAsset(projectId);
	const del = useDeleteProjectAsset(projectId);
	const archive = useArchiveProjectAsset(projectId);

	// An explicit ?folder wins; otherwise a ?file deep-link opens its containing
	// folder; otherwise the root. Navigation always sets ?folder (and drops
	// ?file), so breadcrumbs can leave a deep-linked file's folder.
	const currentFolder = folderParam ?? (focusFile ? assetFolder(focusFile) : '');
	const folderDepth = currentFolder === '' ? 0 : currentFolder.split('/').length;

	const openFolder = useCallback(
		(path: string) => {
			navigate({ search: path ? { folder: path } : {} });
		},
		[navigate],
	);

	const inputRef = useRef<HTMLInputElement>(null);
	const [isDragActive, setIsDragActive] = useState(false);
	const dragDepth = useRef(0);
	const [errors, setErrors] = useState<ErrorChip[]>([]);
	const [pendingDelete, setPendingDelete] = useState<ProjectAsset | null>(null);
	const [pendingMove, setPendingMove] = useState<ProjectAsset | null>(null);
	const [viewMarkdown, setViewMarkdown] = useState<ProjectAsset | null>(null);
	const [newFolderOpen, setNewFolderOpen] = useState(false);

	const pushError = useCallback((filename: string, message: string) => {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		setErrors((prev) => [...prev, { id, filename, message }]);
		setTimeout(() => setErrors((prev) => prev.filter((e) => e.id !== id)), 5000);
	}, []);

	const handleFiles = useCallback(
		async (files: File[]) => {
			for (const file of files) {
				// A directory dragged from the OS arrives as an extensionless "file";
				// folders can't be uploaded — files land in the folder that's open.
				if (!file.type && !file.name.includes('.')) {
					pushError(file.name, 'Folders can’t be uploaded — upload files individually');
					continue;
				}
				try {
					await upload.mutateAsync({ file, folder: currentFolder });
				} catch (e) {
					pushError(file.name, (e as ApiError)?.message ?? 'Upload failed');
				}
			}
		},
		[upload, pushError, currentFolder],
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
	// Filter before grouping so folder cards and their file counts reflect the
	// current view (a folder with only archived files disappears from Active).
	const visibleAssets = (assets ?? []).filter((a) => matchesArchiveFilter(a.archived_at, filter));
	const grouped = groupAssets(visibleAssets, currentFolder);
	const filterCounts: Record<ArchiveFilter, number> = {
		[ArchiveFilter.All]: assets?.length ?? 0,
		[ArchiveFilter.Archived]: (assets ?? []).filter((a) => a.archived_at != null).length,
		[ArchiveFilter.Active]: (assets ?? []).filter((a) => a.archived_at == null).length,
	};
	const groupedIsEmpty = grouped.folders.length === 0 && grouped.items.length === 0;
	// Inside a folder the "drop files here" empty state stays primary (it also
	// backs the virtual new-folder flow); the Archived view gets its own message
	// since dropping files there would land them as active and stay invisible.
	const filterIsEmpty =
		(assets?.length ?? 0) > 0 &&
		groupedIsEmpty &&
		(currentFolder === '' || filter === ArchiveFilter.Archived);
	const folderIsEmpty = groupedIsEmpty && currentFolder !== '' && filter !== ArchiveFilter.Archived;

	const setFilter = useCallback(
		(next: ArchiveFilter) => {
			navigate({
				search: (prev) => ({
					...(prev as AssetsSearch),
					filter: next === ArchiveFilter.Active ? undefined : next,
				}),
				replace: true,
			});
		},
		[navigate],
	);

	const crumbs: BreadcrumbSegment[] = [
		{ key: '', label: 'Assets', onNavigate: () => openFolder('') },
		...folderCrumbs(currentFolder).map((c) => ({
			key: c.path,
			label: c.name,
			onNavigate: () => openFolder(c.path),
		})),
	];

	return (
		<div>
			<div className="flex flex-wrap items-start justify-between gap-2 mb-4">
				{/* Root shows the page title + blurb; inside a folder the breadcrumb
				    takes its place so the header stays a single orienting row. */}
				<div className="min-w-0">
					{currentFolder === '' ? (
						<>
							<h1 className="text-base font-semibold text-text-1">Assets</h1>
							<p className="text-[13px] text-text-2">
								Generated and uploaded assets, organised into folders.
							</p>
						</>
					) : (
						<div className="flex min-h-[26px] items-center">
							<Breadcrumb segments={crumbs} data-testid="assets-breadcrumb" />
						</div>
					)}
				</div>
				<div className="flex items-center gap-2">
					{folderDepth < ASSET_MAX_FOLDER_DEPTH && (
						<Button
							size="sm"
							variant="secondary"
							onClick={() => setNewFolderOpen(true)}
							data-testid="asset-new-folder-button"
						>
							<FolderPlus className="w-3.5 h-3.5" />
							New folder
						</Button>
					)}
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
				</div>
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

			<AssetFilterControl filter={filter} counts={filterCounts} onChange={setFilter} />

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
				) : filterIsEmpty ? (
					<EmptyState
						icon={<Archive className="w-10 h-10" />}
						title={filter === ArchiveFilter.Archived ? 'No archived assets' : 'No active assets'}
						description={
							filter === ArchiveFilter.Archived
								? 'Assets that you or agents archive appear here.'
								: 'Everything is archived — switch the filter to Archived to browse or restore items.'
						}
					/>
				) : folderIsEmpty ? (
					<EmptyState
						icon={<Folder className="w-10 h-10" />}
						title="This folder is empty"
						description="Drop files here or use Upload — the folder persists once a file lands in it."
					/>
				) : (
					<ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
						{grouped.folders.map((folder) => (
							<li key={folder.path}>
								{/* A folder reads as a small stack of cards: two darker lips
								    (surface-3, strong border, elevated) peek above the raised top
								    card so it's unmistakable next to the flat, white file cards.
								    The top card keeps the file card's exact footprint (h-28 media
								    + p-2 footer) so folders and files stay the same size; the lips
								    are absolutely positioned in the grid gap and add no layout
								    height. Folders keep the grey surface-2 fill (and its dark-mode
								    counterpart); file cards use the lighter surface. */}
								<button
									type="button"
									data-testid="asset-folder-card"
									data-folder={folder.path}
									onClick={() => openFolder(folder.path)}
									className="group relative block w-full text-left"
								>
									<span
										aria-hidden="true"
										className="absolute inset-x-5 -top-2 h-5 rounded-t-md border border-border-strong bg-surface-3 shadow-sm"
									/>
									<span
										aria-hidden="true"
										className="absolute inset-x-2.5 -top-1 h-5 rounded-t-md border border-border-strong bg-surface-3 shadow-sm"
									/>
									<span className="relative flex flex-col overflow-hidden rounded-md border border-border bg-surface-2 shadow-md transition group-hover:border-border-strong group-hover:shadow-lg">
										<span className="flex h-28 items-center justify-center">
											<Folder className="h-16 w-16 text-text-3" />
										</span>
										<span className="block p-2">
											<span
												className="block truncate text-[12px] font-medium text-text-1"
												title={folder.path}
											>
												{folder.name}
											</span>
											<span className="block text-[11px] text-text-3">
												{folder.count} file{folder.count === 1 ? '' : 's'}
											</span>
										</span>
									</span>
								</button>
							</li>
						))}
						{grouped.items.map((asset) => (
							<AssetCard
								key={asset.id}
								asset={asset}
								highlighted={focusFile === asset.original_filename}
								onDelete={() => setPendingDelete(asset)}
								onMove={() => setPendingMove(asset)}
								onView={() => setViewMarkdown(asset)}
								onArchive={() => archive.mutate({ assetId: asset.id, archived: true })}
								onRestore={() => archive.mutate({ assetId: asset.id, archived: false })}
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
						<p className="text-[13px] text-text-3">
							Drop to upload{currentFolder ? ` into ${currentFolder}` : ''}
						</p>
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

			<NewFolderDialog
				open={newFolderOpen}
				onOpenChange={setNewFolderOpen}
				currentFolder={currentFolder}
				onCreate={openFolder}
			/>

			{pendingMove && (
				<MoveAssetDialog
					projectId={projectId}
					asset={pendingMove}
					assets={assets ?? []}
					open={pendingMove !== null}
					onOpenChange={(open) => {
						if (!open) setPendingMove(null);
					}}
				/>
			)}

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

/**
 * "New folder" navigates into a virtual empty folder — implicit path folders
 * only exist once an asset lands in them, so nothing persists until the first
 * upload (the empty state says as much).
 */
function NewFolderDialog({
	open,
	onOpenChange,
	currentFolder,
	onCreate,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	currentFolder: string;
	onCreate: (path: string) => void;
}) {
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			setName('');
			setError(null);
		}
	}, [open]);

	function submit() {
		const target = currentFolder ? `${currentFolder}/${name}` : name;
		const normalized = name.trim() === '' ? null : normalizeAssetFolder(target);
		if (!normalized) {
			setError(
				`Folder names start with a letter or digit and nest at most ${ASSET_MAX_FOLDER_DEPTH} levels deep.`,
			);
			return;
		}
		onOpenChange(false);
		onCreate(normalized);
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm" aria-describedby={undefined} data-testid="asset-new-folder-dialog">
				<Dialog.Title className="text-base font-semibold mb-4 pr-8">New folder</Dialog.Title>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<Input
						label={currentFolder ? `Folder name (inside ${currentFolder})` : 'Folder name'}
						value={name}
						onChange={(e) => {
							setName(e.target.value);
							setError(null);
						}}
						placeholder="launch-campaign"
						data-testid="asset-new-folder-input"
						// biome-ignore lint/a11y/noAutofocus: single-field dialog
						autoFocus
					/>
					{error && (
						<p className="mt-1.5 text-[12px] text-danger" data-testid="asset-new-folder-error">
							{error}
						</p>
					)}
					<p className="mt-2 text-[12px] text-text-3">
						The folder persists once the first file is uploaded into it.
					</p>
					<div className="mt-4 flex justify-end gap-2">
						<Button type="button" size="sm" variant="secondary" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" size="sm" data-testid="asset-new-folder-create">
							Create
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog.Root>
	);
}

/** Whether the library-root option ("Assets (root)") matches the search query. */
function rootMatchesQuery(query: string): boolean {
	const q = query.trim().toLowerCase();
	return q === '' || 'assets (root)'.includes(q) || 'root'.includes(q);
}

/**
 * Searchable folder picker for the move dialog: a text input that opens a
 * dropdown of existing folders, filtered as you type, with subfolders indented
 * one level under their parent so the nesting reads as a tree. The library root
 * ("Assets (root)") is always the first option. `value` is the selected folder
 * path ('' = root, `null` = nothing selected, e.g. while a new folder is typed).
 */
function FolderCombobox({
	folders,
	value,
	currentFolder,
	disabled,
	onSelect,
}: {
	folders: string[];
	value: string | null;
	currentFolder: string;
	disabled?: boolean;
	onSelect: (path: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [activeIndex, setActiveIndex] = useState(0);
	const containerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const options: string[] = [
		...(rootMatchesQuery(query) ? [''] : []),
		...filterFolderTree(folders, query),
	];

	// Close when a pointer lands outside the combobox (option clicks stay inside).
	useEffect(() => {
		if (!open) return;
		function onPointerDown(e: PointerEvent) {
			if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
		}
		document.addEventListener('pointerdown', onPointerDown);
		return () => document.removeEventListener('pointerdown', onPointerDown);
	}, [open]);

	function choose(path: string) {
		onSelect(path);
		setQuery('');
		setOpen(false);
		inputRef.current?.blur();
	}

	function openDropdown() {
		if (disabled) return;
		setQuery('');
		setActiveIndex(0);
		setOpen(true);
	}

	function onKeyDown(e: React.KeyboardEvent) {
		if (e.key === 'Escape') {
			if (open) e.stopPropagation(); // keep Escape from also closing the dialog
			setOpen(false);
			return;
		}
		if (!open) {
			if (e.key === 'ArrowDown' || e.key === 'Enter') {
				e.preventDefault();
				openDropdown();
			}
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setActiveIndex((i) => Math.min(options.length - 1, i + 1));
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setActiveIndex((i) => Math.max(0, i - 1));
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const path = options[activeIndex];
			if (path !== undefined) choose(path);
		}
	}

	const selectedLabel = value === null ? '' : value === '' ? 'Assets (root)' : value;

	return (
		<div className="flex flex-col gap-1.5">
			<span id="asset-move-folder-label" className="text-eyebrow text-text-2">
				Folder
			</span>
			<div ref={containerRef} className="relative">
				<div className="flex h-8 w-full items-center gap-2 rounded-md border border-border-strong bg-surface px-2.5 text-[13px] transition-colors focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring">
					<Search className="h-3.5 w-3.5 shrink-0 text-text-3" />
					<input
						ref={inputRef}
						role="combobox"
						aria-expanded={open}
						aria-controls="asset-move-folder-list"
						aria-autocomplete="list"
						aria-labelledby="asset-move-folder-label"
						aria-activedescendant={
							open && options.length > 0 ? `asset-move-opt-${activeIndex}` : undefined
						}
						disabled={disabled}
						value={open ? query : selectedLabel}
						placeholder={open && selectedLabel ? selectedLabel : 'Search folders…'}
						onFocus={openDropdown}
						onChange={(e) => {
							setQuery(e.target.value);
							setActiveIndex(0);
							setOpen(true);
						}}
						onKeyDown={onKeyDown}
						className="min-w-0 flex-1 bg-transparent text-text-1 placeholder:text-text-3 outline-none"
						data-testid="asset-move-folder-input"
					/>
					<ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-3" />
				</div>
				{open && (
					<div
						id="asset-move-folder-list"
						role="listbox"
						aria-label="Existing folders"
						className="absolute left-0 right-0 z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-md"
					>
						{options.length === 0 ? (
							<div className="px-2.5 py-2 text-[13px] text-text-3" data-testid="asset-move-empty">
								No folders match “{query.trim()}”.
							</div>
						) : (
							options.map((path, i) => {
								const indent = folderIndentLevel(path);
								const label = path === '' ? 'Assets (root)' : folderLeafName(path);
								const isSelected = value === path;
								const isActive = i === activeIndex;
								return (
									<button
										key={path === '' ? '(root)' : path}
										id={`asset-move-opt-${i}`}
										type="button"
										role="option"
										aria-selected={isSelected}
										data-testid="asset-move-option"
										data-folder={path}
										data-indent={indent}
										title={path === '' ? 'Assets (root)' : path}
										onMouseEnter={() => setActiveIndex(i)}
										onClick={() => choose(path)}
										style={{ paddingLeft: `${0.625 + indent}rem` }}
										className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2.5 text-left text-[13px] transition-colors ${
											isActive
												? 'bg-surface-3 text-text-1'
												: isSelected
													? 'bg-surface-2 text-text-1'
													: 'text-text-2 hover:bg-surface-3 hover:text-text-1'
										}`}
									>
										<Folder className="h-3.5 w-3.5 shrink-0 text-text-3" />
										<span className="min-w-0 flex-1 truncate">{label}</span>
										{path === currentFolder && (
											<span className="shrink-0 text-[11px] text-text-3">current</span>
										)}
										{isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-info" />}
									</button>
								);
							})
						)}
					</div>
				)}
			</div>
		</div>
	);
}

/** Admin "Move to folder" — PATCHes the asset's folder; 409 on collision. */
function MoveAssetDialog({
	projectId,
	asset,
	assets,
	open,
	onOpenChange,
}: {
	projectId: string;
	asset: ProjectAsset;
	assets: ProjectAsset[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const move = useMoveProjectAsset(projectId);
	const from = assetFolder(asset.original_filename);
	const [selected, setSelected] = useState(from);
	const [newName, setNewName] = useState('');
	const [error, setError] = useState<string | null>(null);
	const folders = allFolders(assets);

	const targetFromNewName = newName.trim() !== '';

	async function submit() {
		let target = selected;
		if (targetFromNewName) {
			const normalized = normalizeAssetFolder(newName);
			if (normalized === null || normalized === '') {
				setError(
					`Folder names start with a letter or digit and nest at most ${ASSET_MAX_FOLDER_DEPTH} levels deep.`,
				);
				return;
			}
			target = normalized;
		}
		try {
			await move.mutateAsync({ assetId: asset.id, folder: target });
			onOpenChange(false);
		} catch (e) {
			setError((e as ApiError)?.message ?? 'Move failed');
		}
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm" aria-describedby={undefined} data-testid="asset-move-dialog">
				<Dialog.Title className="text-base font-semibold mb-1 pr-8">Move to folder</Dialog.Title>
				<p className="mb-3 truncate text-[13px] text-text-2" title={asset.original_filename}>
					{asset.original_filename}
				</p>
				<FolderCombobox
					folders={folders}
					value={targetFromNewName ? null : selected}
					currentFolder={from}
					disabled={move.isPending}
					onSelect={(path) => {
						setSelected(path);
						setNewName('');
						setError(null);
					}}
				/>
				<div className="mt-3">
					<Input
						label="Or a new folder"
						value={newName}
						onChange={(e) => {
							setNewName(e.target.value);
							setError(null);
						}}
						placeholder="archive"
						data-testid="asset-move-new-folder"
					/>
				</div>
				{error && (
					<p className="mt-1.5 text-[12px] text-danger" data-testid="asset-move-error">
						{error}
					</p>
				)}
				<div className="mt-4 flex justify-end gap-2">
					<Button type="button" size="sm" variant="secondary" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						type="button"
						size="sm"
						onClick={submit}
						disabled={move.isPending}
						data-testid="asset-move-confirm"
					>
						{move.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
						Move
					</Button>
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}

/**
 * Copies an asset's canonical `assets/<path>` reference — the exact string that
 * linkifies in comments and docs — to the clipboard, swapping its icon to a
 * check for 1.5s as confirmation (mirrors the comment/log copy affordances).
 */
function CopyReferenceButton({ reference }: { reference: string }) {
	const [copied, setCopied] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, []);

	const handleCopy = async () => {
		if (await copyToClipboard(reference)) {
			setCopied(true);
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			timeoutRef.current = setTimeout(() => setCopied(false), 1500);
		}
	};

	return (
		<Tooltip content={copied ? 'Copied!' : 'Copy link'}>
			<button
				type="button"
				className="p-1 text-text-3 hover:text-text-1"
				onClick={handleCopy}
				aria-label={copied ? 'Reference copied' : 'Copy reference link'}
				data-testid="asset-copy-link"
			>
				{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
			</button>
		</Tooltip>
	);
}

function AssetCard({
	asset,
	highlighted,
	onDelete,
	onMove,
	onView,
	onArchive,
	onRestore,
}: {
	asset: ProjectAsset;
	highlighted: boolean;
	onDelete: () => void;
	onMove: () => void;
	onView: () => void;
	onArchive: () => void;
	onRestore: () => void;
}) {
	const ref = useRef<HTMLLIElement>(null);
	useEffect(() => {
		if (highlighted) ref.current?.scrollIntoView({ block: 'center' });
	}, [highlighted]);

	const isImage = asset.content_type.startsWith('image/');
	const isHtml = asset.content_type === 'text/html';
	const isMarkdown = isMarkdownAssetMime(asset.content_type);
	const isArchived = asset.archived_at != null;
	const basename = assetBasename(asset.original_filename);
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
	// Archived media dims and desaturates; the corner badge names the state.
	const mediaClass = `flex h-28 items-center justify-center bg-surface-3 ${
		isArchived ? '[&>*]:opacity-55 [&>*]:grayscale-[0.75]' : ''
	}`;
	return (
		<li
			ref={ref}
			data-testid="asset-card"
			data-filename={asset.original_filename}
			data-archived={isArchived || undefined}
			className={`relative flex flex-col overflow-hidden rounded-md border bg-surface ${
				highlighted ? 'border-info' : 'border-border'
			}`}
		>
			{/* Markdown renders in-app (rich preview + view-source); everything else
			    opens its raw signed URL in a new tab. */}
			{isMarkdown ? (
				<button
					type="button"
					onClick={onView}
					className={mediaClass}
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
					className={mediaClass}
					data-testid="asset-open-link"
					aria-label={`Open ${asset.original_filename} in a new tab`}
				>
					{thumbnail}
				</a>
			)}
			{isArchived && (
				<span className="absolute right-1.5 top-1.5">
					<ArchivedBadge overlay />
				</span>
			)}
			<div className="flex items-start justify-between gap-1 p-2">
				<div className="min-w-0">
					<div
						className={`truncate text-[12px] font-medium ${isArchived ? 'text-text-3' : 'text-text-1'}`}
						title={asset.original_filename}
					>
						{basename}
					</div>
					<div className="text-[11px] text-text-3">{formatBytes(asset.byte_size)}</div>
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					<Tooltip content="Open in new tab">
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
					</Tooltip>
					{isArchived ? (
						<>
							{/* Restore first; the hard delete only lives on archived cards —
							    active cards offer the reversible Archive instead. */}
							<Tooltip content="Restore asset">
								<button
									type="button"
									className="p-1 text-text-3 hover:text-text-1"
									onClick={onRestore}
									aria-label="Restore asset"
									data-testid="asset-restore"
								>
									<ArchiveRestore className="h-3.5 w-3.5" />
								</button>
							</Tooltip>
							<Tooltip content="Delete permanently">
								<button
									type="button"
									className="p-1 text-text-3 hover:text-danger"
									onClick={onDelete}
									aria-label="Delete asset"
									data-testid="asset-delete"
								>
									<Trash2 className="h-3.5 w-3.5" />
								</button>
							</Tooltip>
						</>
					) : (
						<>
							<CopyReferenceButton reference={`assets/${asset.original_filename}`} />
							<Tooltip content="Move to folder">
								<button
									type="button"
									className="p-1 text-text-3 hover:text-text-1"
									onClick={onMove}
									aria-label="Move to folder"
									data-testid="asset-move"
								>
									<FolderInput className="h-3.5 w-3.5" />
								</button>
							</Tooltip>
							<Tooltip content="Archive asset">
								<button
									type="button"
									className="p-1 text-text-3 hover:text-text-1"
									onClick={onArchive}
									aria-label="Archive asset"
									data-testid="asset-archive"
								>
									<Archive className="h-3.5 w-3.5" />
								</button>
							</Tooltip>
						</>
					)}
				</div>
			</div>
		</li>
	);
}

export const Route = createFileRoute('/projects/$projectId/assets')({
	validateSearch: (search: Record<string, unknown>): AssetsSearch => ({
		file: typeof search.file === 'string' ? search.file : undefined,
		folder: typeof search.folder === 'string' ? search.folder : undefined,
		filter:
			isArchiveFilter(search.filter) && search.filter !== ArchiveFilter.Active
				? search.filter
				: undefined,
	}),
	// HQ (the internal coordination project) exposes Assets too: it's where the
	// CEO saves files it produces for the operator in chat (write_project_asset),
	// so `assets/<filename>` references in the chat resolve to a real page.
	component: ProjectAssetsPage,
});

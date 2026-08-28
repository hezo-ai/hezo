import {
	ArchiveFilter,
	ASSET_MAX_FOLDER_DEPTH,
	ASSET_SORT_FIELDS,
	type AssetSortDirection,
	AssetSortField,
	AssetSortOrder,
	assetBasename,
	assetFolder,
	assetSortDirection,
	assetSortField,
	assetSortOrderFor,
	compareAssetsForSort,
	isArchiveFilter,
	isAssetSortOrder,
	isMarkdownAssetMime,
	matchesArchiveFilter,
	normalizeAssetFolder,
} from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { createFileRoute } from '@tanstack/react-router';
import {
	Archive,
	ArrowDownWideNarrow,
	Check,
	ChevronDown,
	Filter,
	Folder,
	FolderPlus,
	Image as ImageIcon,
	LayoutGrid,
	List,
	Loader2,
	Search,
	SlidersHorizontal,
	Upload,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AssetActions } from '../../../components/asset-actions';
import { AssetFilterDialog } from '../../../components/asset-filter-dialog';
import { AssetIcon, formatBytes } from '../../../components/asset-icon';
import { AssetList } from '../../../components/asset-list';
import { CsvThumbnail } from '../../../components/csv-thumbnail';
import { MarkdownThumbnail } from '../../../components/markdown-thumbnail';
import { ArchivedBadge } from '../../../components/ui/archived-badge';
import { Breadcrumb, type BreadcrumbSegment } from '../../../components/ui/breadcrumb';
import { Button } from '../../../components/ui/button';
import { ConfirmDialog } from '../../../components/ui/confirm-dialog';
import { CountOverlayBadge } from '../../../components/ui/count-overlay-badge';
import { DialogContent } from '../../../components/ui/dialog';
import { EmptyState } from '../../../components/ui/empty-state';
import { Input } from '../../../components/ui/input';
import { RelativeTime } from '../../../components/ui/relative-time';
import { SegmentedControl } from '../../../components/ui/segmented-control';
import { useMediaQuery } from '../../../hooks/use-media-query';
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
import { AssetView, isAssetView } from '../../../lib/asset-view';
import { isCsvAssetPath } from '../../../lib/csv';
import { type MessageKey, useI18n } from '../../../lib/i18n';

interface AssetsSearch {
	file?: string;
	folder?: string;
	/** Archive filter — absent means the default Active view. */
	filter?: ArchiveFilter;
	/** Sort order — absent means the default Newest-first view. */
	sort?: AssetSortOrder;
	/** Layout — absent means the default grid of cards. */
	view?: AssetView;
}

const FILTER_TEXT: Record<ArchiveFilter, MessageKey> = {
	[ArchiveFilter.Active]: 'assets.filter.showingActive',
	[ArchiveFilter.Archived]: 'assets.filter.showingArchived',
	[ArchiveFilter.All]: 'assets.filter.showingAll',
};

const FILTER_OPTION_TEXT: Record<ArchiveFilter, MessageKey> = {
	[ArchiveFilter.Active]: 'assets.filter.active',
	[ArchiveFilter.Archived]: 'assets.filter.archived',
	[ArchiveFilter.All]: 'assets.filter.all',
};

/** The toolbar caption for each order — one phrase per language, not two joined. */
const SORT_TEXT: Record<AssetSortOrder, MessageKey> = {
	[AssetSortOrder.Newest]: 'assets.sort.newest',
	[AssetSortOrder.Oldest]: 'assets.sort.oldest',
	[AssetSortOrder.Alphabetical]: 'assets.sort.nameAsc',
	[AssetSortOrder.AlphabeticalDesc]: 'assets.sort.nameDesc',
	[AssetSortOrder.SizeAsc]: 'assets.sort.sizeAsc',
	[AssetSortOrder.SizeDesc]: 'assets.sort.sizeDesc',
	[AssetSortOrder.TypeAsc]: 'assets.sort.typeAsc',
	[AssetSortOrder.TypeDesc]: 'assets.sort.typeDesc',
};

/** A sortable column's name — the same word its list-view header carries. */
const SORT_FIELD_TEXT: Record<AssetSortField, MessageKey> = {
	[AssetSortField.Name]: 'assets.column.name',
	[AssetSortField.Type]: 'assets.column.type',
	[AssetSortField.Size]: 'assets.column.size',
	[AssetSortField.Modified]: 'assets.column.modified',
};

/**
 * What each direction is called for a given column. The two textual columns
 * share one pair of words, which is the point of reading the direction off a
 * table rather than composing "{column} {direction}" — that would freeze
 * English word order into all twelve catalogs.
 */
const SORT_DIRECTION_TEXT: Record<AssetSortField, Record<AssetSortDirection, MessageKey>> = {
	[AssetSortField.Name]: { asc: 'assets.sort.dir.ascending', desc: 'assets.sort.dir.descending' },
	[AssetSortField.Type]: { asc: 'assets.sort.dir.ascending', desc: 'assets.sort.dir.descending' },
	[AssetSortField.Size]: { asc: 'assets.sort.dir.smallest', desc: 'assets.sort.dir.largest' },
	[AssetSortField.Modified]: { asc: 'assets.sort.dir.oldest', desc: 'assets.sort.dir.newest' },
};

const SORT_FIELDS = Object.values(AssetSortField);
const ARCHIVE_FILTERS = [ArchiveFilter.Active, ArchiveFilter.Archived, ArchiveFilter.All];

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
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	return (
		<div className="flex items-center gap-1.5">
			<span className="text-[12.5px] text-text-2" data-testid="asset-filter-text">
				{t(FILTER_TEXT[filter])}
			</span>
			<Popover.Root open={open} onOpenChange={setOpen}>
				<Popover.Trigger asChild>
					<button
						type="button"
						aria-label={t('assets.filter.label')}
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
						{ARCHIVE_FILTERS.map((value) => {
							const selected = filter === value;
							return (
								<button
									key={value}
									type="button"
									role="menuitemradio"
									aria-checked={selected}
									data-testid={`asset-filter-option-${value}`}
									onClick={() => {
										onChange(value);
										setOpen(false);
									}}
									className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors cursor-pointer text-left ${
										selected
											? 'bg-surface-2 text-text-1'
											: 'text-text-2 hover:bg-surface-3 hover:text-text-1'
									}`}
								>
									<span className="flex-1">{t(FILTER_OPTION_TEXT[value])}</span>
									<span className="font-mono text-[11px] text-text-3">{counts[value]}</span>
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

/**
 * The current order's caption + a button opening a popover of the four sortable
 * columns. Picking the column already sorted on reverses it — the same gesture
 * the list view's headers make, reaching the same eight orders, because both
 * hand a column to `onPick` and the page turns it into an `AssetSortOrder`.
 *
 * A sibling of AssetFilterControl; the sort is a client-side view concern (the
 * full list is already fetched), persisted in the URL.
 */
function AssetSortControl({
	sort,
	onPick,
}: {
	sort: AssetSortOrder;
	onPick: (field: AssetSortField) => void;
}) {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const activeField = assetSortField(sort);
	const activeDirection = assetSortDirection(sort);
	return (
		<div className="flex items-center gap-1.5">
			<span className="text-[12.5px] text-text-2" data-testid="asset-sort-text">
				{t(SORT_TEXT[sort])}
			</span>
			<Popover.Root open={open} onOpenChange={setOpen}>
				<Popover.Trigger asChild>
					<button
						type="button"
						aria-label={t('assets.sort.label')}
						data-testid="asset-sort-button"
						className={`inline-flex items-center rounded-md border p-1.5 transition-colors cursor-pointer ${
							sort === AssetSortOrder.Newest
								? 'border-border bg-surface text-text-2 hover:border-border-strong hover:text-text-1'
								: 'border-border-strong bg-surface-2 text-text-1'
						}`}
					>
						<ArrowDownWideNarrow className="h-3.5 w-3.5" />
					</button>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						align="start"
						sideOffset={4}
						className="z-50 min-w-[210px] rounded-md border border-border bg-surface p-1 shadow-md"
						data-testid="asset-sort-popover"
					>
						{SORT_FIELDS.map((field) => {
							const selected = field === activeField;
							// An unselected column advertises the direction a click would
							// take it in, so the row says what will happen.
							const direction = selected ? activeDirection : ASSET_SORT_FIELDS[field].first;
							return (
								<button
									key={field}
									type="button"
									role="menuitemradio"
									aria-checked={selected}
									data-testid={`asset-sort-option-${field}`}
									onClick={() => onPick(field)}
									className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors cursor-pointer text-left ${
										selected
											? 'bg-surface-2 text-text-1'
											: 'text-text-2 hover:bg-surface-3 hover:text-text-1'
									}`}
								>
									<span className="flex-1">{t(SORT_FIELD_TEXT[field])}</span>
									<span
										className={`text-[11px] ${selected ? 'text-info' : 'text-text-3'}`}
										data-testid={`asset-sort-direction-${field}`}
									>
										{t(SORT_DIRECTION_TEXT[field][direction])}
									</span>
									{selected && <Check className="h-3.5 w-3.5 shrink-0 text-info" />}
								</button>
							);
						})}
						<p className="border-t border-border px-2.5 pb-1 pt-2 text-[11px] text-text-3">
							{t('assets.sort.reverseHint')}
						</p>
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

function ProjectAssetsPage() {
	const { t, plural } = useI18n();
	const { projectId } = Route.useParams();
	const {
		file: focusFile,
		folder: folderParam,
		filter = ArchiveFilter.Active,
		sort = AssetSortOrder.Newest,
		view = AssetView.Grid,
	} = Route.useSearch();
	const navigate = Route.useNavigate();
	const { data: assets, isLoading } = useProjectAssets(projectId);
	const upload = useUploadProjectAsset(projectId);
	const del = useDeleteProjectAsset(projectId);
	const archive = useArchiveProjectAsset(projectId);
	// Two caption-plus-button pairs and the view toggle do not share a phone's
	// toolbar row, so below `md` the filter and sort move into a dialog.
	const isDesktop = useMediaQuery('(min-width: 768px)');

	// An explicit ?folder wins; otherwise a ?file deep-link opens its containing
	// folder; otherwise the root. Navigation always sets ?folder (and drops
	// ?file), so breadcrumbs can leave a deep-linked file's folder.
	const currentFolder = folderParam ?? (focusFile ? assetFolder(focusFile) : '');
	const folderDepth = currentFolder === '' ? 0 : currentFolder.split('/').length;

	const openFolder = useCallback(
		(path: string) => {
			// Entering a folder drops the deep-linked file, but carries the view:
			// grid-or-list is the reader's standing choice, not the folder's.
			navigate({
				search: (prev) => ({ folder: path || undefined, view: (prev as AssetsSearch).view }),
			});
		},
		[navigate],
	);

	const inputRef = useRef<HTMLInputElement>(null);
	const [isDragActive, setIsDragActive] = useState(false);
	const dragDepth = useRef(0);
	const [errors, setErrors] = useState<ErrorChip[]>([]);
	const [pendingDelete, setPendingDelete] = useState<ProjectAsset | null>(null);
	const [pendingMove, setPendingMove] = useState<ProjectAsset | null>(null);
	const [newFolderOpen, setNewFolderOpen] = useState(false);
	const [filtersOpen, setFiltersOpen] = useState(false);

	// Every asset opens in the in-app viewer (where review comments live); the
	// card's corner popout keeps raw new-tab access.
	const openViewer = useCallback(
		(asset: ProjectAsset) => {
			navigate({
				to: '/projects/$projectId/assets/view',
				search: {
					file: asset.original_filename,
					...(filter !== ArchiveFilter.Active ? { filter } : {}),
				},
			});
		},
		[navigate, filter],
	);

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
					pushError(file.name, t('assets.error.folderUpload'));
					continue;
				}
				try {
					await upload.mutateAsync({ file, folder: currentFolder });
				} catch (e) {
					pushError(file.name, (e as ApiError)?.message ?? t('assets.error.uploadFailed'));
				}
			}
		},
		[upload, pushError, currentFolder, t],
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
	// Sort client-side (the full list is already fetched) with the shared
	// comparator the API mirrors; folder cards keep their own alphabetical order.
	const visibleAssets = (assets ?? [])
		.filter((a) => matchesArchiveFilter(a.archived_at, filter))
		.sort((a, b) => compareAssetsForSort(a, b, sort));
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

	const setSort = useCallback(
		(next: AssetSortOrder) => {
			navigate({
				search: (prev) => ({
					...(prev as AssetsSearch),
					sort: next === AssetSortOrder.Newest ? undefined : next,
				}),
				replace: true,
			});
		},
		[navigate],
	);

	/**
	 * The one place a column becomes an order, so a list header, the sort popover
	 * and the mobile dialog cannot drift: asking for the column already sorted on
	 * reverses it, and asking for any other adopts that column's own first
	 * direction (largest and newest first; A→Z for the textual two).
	 */
	const pickSortField = useCallback(
		(field: AssetSortField) => {
			const direction: AssetSortDirection =
				assetSortField(sort) === field
					? assetSortDirection(sort) === 'asc'
						? 'desc'
						: 'asc'
					: ASSET_SORT_FIELDS[field].first;
			setSort(assetSortOrderFor(field, direction));
		},
		[sort, setSort],
	);

	const setSortPair = useCallback(
		(field: AssetSortField, direction: AssetSortDirection) => {
			setSort(assetSortOrderFor(field, direction));
		},
		[setSort],
	);

	const setView = useCallback(
		(next: AssetView) => {
			navigate({
				search: (prev) => ({
					...(prev as AssetsSearch),
					view: next === AssetView.Grid ? undefined : next,
				}),
				replace: true,
			});
		},
		[navigate],
	);

	// How many of the two controls are off their default. Shown on the mobile
	// trigger so a narrowed library never reads as an empty one.
	const activeFilterCount =
		(filter === ArchiveFilter.Active ? 0 : 1) + (sort === AssetSortOrder.Newest ? 0 : 1);

	const crumbs: BreadcrumbSegment[] = [
		{ key: '', label: t('nav.assets'), onNavigate: () => openFolder('') },
		...folderCrumbs(currentFolder).map((c) => ({
			key: c.path,
			label: c.name,
			onNavigate: () => openFolder(c.path),
		})),
	];

	const viewToggle = (
		<SegmentedControl
			options={[
				{ value: AssetView.Grid, label: t('assets.view.grid'), icon: LayoutGrid },
				{ value: AssetView.List, label: t('assets.view.list'), icon: List },
			]}
			value={view}
			onChange={setView}
			label={t('assets.view.label')}
			collapseToIcons
			className="w-[152px] shrink-0"
			testId="asset-view-toggle"
		/>
	);

	return (
		<div>
			<div className="flex flex-wrap items-start justify-between gap-2 mb-4">
				{/* Root shows the page title + blurb; inside a folder the breadcrumb
				    takes its place so the header stays a single orienting row. */}
				<div className="min-w-0">
					{currentFolder === '' ? (
						<>
							<h1 className="text-base font-semibold text-text-1">{t('nav.assets')}</h1>
							<p className="text-[13px] text-text-2">{t('assets.subtitle')}</p>
						</>
					) : (
						<div className="flex min-h-[26px] items-center">
							<Breadcrumb segments={crumbs} data-testid="assets-breadcrumb" />
						</div>
					)}
				</div>
				{/* Both actions stay reachable on a phone; New folder drops to its
				    icon there, Upload keeps its label as the primary action. */}
				<div className="flex items-center gap-2">
					{folderDepth < ASSET_MAX_FOLDER_DEPTH && (
						<Button
							size="sm"
							variant="secondary"
							onClick={() => setNewFolderOpen(true)}
							aria-label={t('assets.newFolder')}
							data-testid="asset-new-folder-button"
						>
							<FolderPlus className="w-3.5 h-3.5" />
							<span className="hidden sm:inline">{t('assets.newFolder')}</span>
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
						{t('assets.upload')}
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

			<div className="mb-3 flex items-center gap-x-4 gap-y-2">
				{isDesktop ? (
					<>
						<AssetFilterControl filter={filter} counts={filterCounts} onChange={setFilter} />
						<AssetSortControl sort={sort} onPick={pickSortField} />
					</>
				) : (
					<button
						type="button"
						onClick={() => setFiltersOpen(true)}
						aria-label={t('assets.filters.open')}
						aria-haspopup="dialog"
						data-testid="asset-filter-trigger"
						className={`relative inline-flex shrink-0 items-center justify-center rounded-md border p-1.5 transition-colors ${
							activeFilterCount > 0
								? 'border-border-strong bg-surface-2 text-text-1'
								: 'border-border bg-surface text-text-2 hover:border-border-strong hover:text-text-1'
						}`}
					>
						<SlidersHorizontal className="w-3.5 h-3.5" />
						<CountOverlayBadge count={activeFilterCount} testId="asset-filter-count" />
					</button>
				)}
				<span className="flex-1" />
				{viewToggle}
			</div>

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
					<div className="text-text-2 text-[13px] py-4">{t('common.loading')}</div>
				) : !assets || assets.length === 0 ? (
					<EmptyState
						icon={<ImageIcon className="w-10 h-10" />}
						title={t('assets.empty.title')}
						description={t('assets.empty.description')}
					/>
				) : filterIsEmpty ? (
					<EmptyState
						icon={<Archive className="w-10 h-10" />}
						title={
							filter === ArchiveFilter.Archived
								? t('assets.empty.archivedTitle')
								: t('assets.empty.activeTitle')
						}
						description={
							filter === ArchiveFilter.Archived
								? t('assets.empty.archivedDescription')
								: t('assets.empty.activeDescription')
						}
					/>
				) : folderIsEmpty ? (
					<EmptyState
						icon={<Folder className="w-10 h-10" />}
						title={t('assets.empty.folderTitle')}
						description={t('assets.empty.folderDescription')}
					/>
				) : view === AssetView.List ? (
					<AssetList
						folders={grouped.folders}
						items={grouped.items}
						sort={sort}
						focusFile={focusFile}
						onSortField={pickSortField}
						onOpenFolder={openFolder}
						onView={openViewer}
						onDelete={setPendingDelete}
						onMove={setPendingMove}
						onArchive={(asset) => archive.mutate({ assetId: asset.id, archived: true })}
						onRestore={(asset) => archive.mutate({ assetId: asset.id, archived: false })}
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
												{plural('assets.files', folder.count, { count: folder.count })}
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
								onView={() => openViewer(asset)}
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
							{currentFolder
								? t('assets.drop.intoFolder', { folder: currentFolder })
								: t('assets.drop.here')}
						</p>
					</div>
				)}
			</div>

			{!isDesktop && (
				<AssetFilterDialog
					open={filtersOpen}
					onOpenChange={setFiltersOpen}
					filterOptions={ARCHIVE_FILTERS.map((value) => ({
						value,
						label: t(FILTER_OPTION_TEXT[value]),
						count: filterCounts[value],
					}))}
					filter={filter}
					onFilterChange={setFilter}
					fieldOptions={SORT_FIELDS.map((value) => ({
						value,
						label: t(SORT_FIELD_TEXT[value]),
					}))}
					directionOptions={(['asc', 'desc'] as const).map((value) => ({
						value,
						label: t(SORT_DIRECTION_TEXT[assetSortField(sort)][value]),
					}))}
					sort={sort}
					onSortChange={setSortPair}
				/>
			)}

			<ConfirmDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) setPendingDelete(null);
				}}
				title={t('assets.delete.title')}
				description={
					deleteCount > 0
						? plural('assets.delete.attached', deleteCount, { count: deleteCount })
						: t('assets.delete.description')
				}
				confirmLabel={t('common.delete')}
				variant="danger"
				onConfirm={async () => {
					if (!pendingDelete) return;
					try {
						await del.mutateAsync(pendingDelete.id);
					} catch (e) {
						pushError(
							pendingDelete.original_filename,
							(e as ApiError)?.message ?? t('assets.error.deleteFailed'),
						);
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
	const { t } = useI18n();
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
			setError(t('assets.folderName.invalid', { max: ASSET_MAX_FOLDER_DEPTH }));
			return;
		}
		onOpenChange(false);
		onCreate(normalized);
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm" aria-describedby={undefined} data-testid="asset-new-folder-dialog">
				<Dialog.Title className="text-base font-semibold mb-4 pr-8">
					{t('assets.newFolder')}
				</Dialog.Title>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<Input
						label={
							currentFolder
								? t('assets.folderName.inside', { folder: currentFolder })
								: t('assets.folderName.label')
						}
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
					<p className="mt-2 text-[12px] text-text-3">{t('assets.folderName.hint')}</p>
					<div className="mt-4 flex justify-end gap-2">
						<Button type="button" size="sm" variant="secondary" onClick={() => onOpenChange(false)}>
							{t('common.cancel')}
						</Button>
						<Button type="submit" size="sm" data-testid="asset-new-folder-create">
							{t('assets.folderName.create')}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog.Root>
	);
}

/** Whether the library-root option ("Assets (root)") matches the search query. */
function rootMatchesQuery(query: string, rootLabel: string): boolean {
	const q = query.trim().toLowerCase();
	return q === '' || rootLabel.toLowerCase().includes(q);
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
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [activeIndex, setActiveIndex] = useState(0);
	const containerRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const rootLabel = t('assets.move.root');
	const options: string[] = [
		...(rootMatchesQuery(query, rootLabel) ? [''] : []),
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

	const selectedLabel = value === null ? '' : value === '' ? rootLabel : value;

	return (
		<div className="flex flex-col gap-1.5">
			<span id="asset-move-folder-label" className="text-eyebrow text-text-2">
				{t('assets.folderType')}
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
						placeholder={open && selectedLabel ? selectedLabel : t('assets.move.searchFolders')}
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
						aria-label={t('assets.move.existingFolders')}
						className="absolute left-0 right-0 z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-md"
					>
						{options.length === 0 ? (
							<div className="px-2.5 py-2 text-[13px] text-text-3" data-testid="asset-move-empty">
								{t('assets.move.noMatch', { query: query.trim() })}
							</div>
						) : (
							options.map((path, i) => {
								const indent = folderIndentLevel(path);
								const label = path === '' ? rootLabel : folderLeafName(path);
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
										title={path === '' ? rootLabel : path}
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
											<span className="shrink-0 text-[11px] text-text-3">
												{t('assets.move.current')}
											</span>
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
	const { t } = useI18n();
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
				setError(t('assets.folderName.invalid', { max: ASSET_MAX_FOLDER_DEPTH }));
				return;
			}
			target = normalized;
		}
		try {
			await move.mutateAsync({ assetId: asset.id, folder: target });
			onOpenChange(false);
		} catch (e) {
			setError((e as ApiError)?.message ?? t('assets.error.moveFailed'));
		}
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm" aria-describedby={undefined} data-testid="asset-move-dialog">
				<Dialog.Title className="text-base font-semibold mb-1 pr-8">
					{t('assets.actions.move')}
				</Dialog.Title>
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
						label={t('assets.move.orNewFolder')}
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
						{t('common.cancel')}
					</Button>
					<Button
						type="button"
						size="sm"
						onClick={submit}
						disabled={move.isPending}
						data-testid="asset-move-confirm"
					>
						{move.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
						{t('assets.move.confirm')}
					</Button>
				</div>
			</DialogContent>
		</Dialog.Root>
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
	const { t } = useI18n();
	const ref = useRef<HTMLLIElement>(null);
	useEffect(() => {
		if (highlighted) ref.current?.scrollIntoView({ block: 'center' });
	}, [highlighted]);

	const isImage = asset.content_type.startsWith('image/');
	const isHtml = asset.content_type === 'text/html';
	const isMarkdown = isMarkdownAssetMime(asset.content_type);
	const isCsv = isCsvAssetPath(asset.original_filename);
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
	) : isMarkdown ? (
		<MarkdownThumbnail url={asset.url} contentType={asset.content_type} />
	) : isCsv ? (
		<CsvThumbnail url={asset.url} contentType={asset.content_type} byteSize={asset.byte_size} />
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
			{/* Every type opens the in-app viewer (split-pane content + review
			    comments); the corner popout keeps raw new-tab access. */}
			<button
				type="button"
				onClick={onView}
				className={mediaClass}
				data-testid="asset-open-viewer"
				aria-label={t('assets.actions.view', { name: asset.original_filename })}
			>
				{thumbnail}
			</button>
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
					<div className="text-[11px] text-text-3">
						{formatBytes(asset.byte_size)} ·{' '}
						{/* The exact timestamp is available on hover (desktop) / tap (touch)
						    via the RelativeTime tooltip. `created_at` is bumped to now() on
						    every overwrite, so this reads as the last time the asset changed. */}
						<RelativeTime iso={asset.created_at} className="cursor-help" testId="asset-updated" />
					</div>
				</div>
				<AssetActions
					asset={asset}
					onDelete={onDelete}
					onMove={onMove}
					onArchive={onArchive}
					onRestore={onRestore}
				/>
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
		sort:
			isAssetSortOrder(search.sort) && search.sort !== AssetSortOrder.Newest
				? search.sort
				: undefined,
		view: isAssetView(search.view) && search.view !== AssetView.Grid ? search.view : undefined,
	}),
	// HQ (the internal coordination project) exposes Assets too: it's where the
	// CEO saves files it produces for the operator in chat (write_project_asset),
	// so `assets/<filename>` references in the chat resolve to a real page.
	component: ProjectAssetsPage,
});

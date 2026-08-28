import {
	AssetSortField,
	type AssetSortOrder,
	assetBasename,
	assetSortDirection,
	assetSortField,
	assetTypeLabel,
} from '@hezo/shared';
import { Folder } from 'lucide-react';
import type { ProjectAsset } from '../hooks/use-project-assets';
import type { AssetFolderEntry } from '../lib/asset-folders';
import { useI18n } from '../lib/i18n';
import { AssetActions } from './asset-actions';
import { AssetIcon, formatBytes } from './asset-icon';
import { ArchivedBadge } from './ui/archived-badge';
import { type Column, DataTable, type DataTableSort } from './ui/data-table';
import { RelativeTime } from './ui/relative-time';

/**
 * One line of the list. Folders and assets share the table so the list reads in
 * the same order the grid does — folders first, then the sorted files.
 */
type AssetRow =
	| { kind: 'folder'; folder: AssetFolderEntry }
	| { kind: 'asset'; asset: ProjectAsset };

/** DOM id for a row, from the library path it stands for. */
function assetRowId(path: string): string {
	return `asset-row-${path}`;
}

/**
 * A row's leading preview: the image itself for a raster asset, the type glyph
 * for everything else.
 *
 * Only images get a real preview because only they cost nothing extra — the
 * browser fetches and caches one, and an off-screen row fetches none at all.
 * The card's markdown, CSV and HTML previews each pull the asset's whole body
 * down to render, which a list would pay for once per row, and at this size
 * they render as an illegible smudge either way.
 */
function RowPreview({ asset }: { asset: ProjectAsset }) {
	const isArchived = asset.archived_at != null;
	return (
		<span
			className={`flex h-7 w-9 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-surface-3 ${
				isArchived ? '[&>*]:opacity-55 [&>*]:grayscale-[0.75]' : ''
			}`}
		>
			{asset.content_type.startsWith('image/') ? (
				<img
					src={asset.url}
					alt=""
					loading="lazy"
					className="h-full w-full object-cover"
					data-testid="asset-row-image"
				/>
			) : (
				<AssetIcon contentType={asset.content_type} className="h-4 w-4 text-text-3" />
			)}
		</span>
	);
}

/**
 * The assets library as a table: full filenames, type, size and modified date in
 * columns you can sort by, for a library of documents and data where a grid of
 * thumbnails says less than a filename does.
 *
 * Sorting is the page's `?sort` state, not a second copy: a header click asks
 * for a field and the page turns it into an `AssetSortOrder`, which is what the
 * toolbar control shows and what the API mirrors. Below `md` the three trailing
 * columns collapse into a second line under the filename, so nothing is lost on
 * a phone.
 */
export function AssetList({
	folders,
	items,
	sort,
	focusFile,
	onSortField,
	onOpenFolder,
	onView,
	onDelete,
	onMove,
	onArchive,
	onRestore,
}: {
	folders: AssetFolderEntry[];
	items: ProjectAsset[];
	sort: AssetSortOrder;
	/** Deep-linked filename: its row scrolls into view and highlights. */
	focusFile?: string;
	onSortField: (field: AssetSortField) => void;
	onOpenFolder: (path: string) => void;
	onView: (asset: ProjectAsset) => void;
	onDelete: (asset: ProjectAsset) => void;
	onMove: (asset: ProjectAsset) => void;
	onArchive: (asset: ProjectAsset) => void;
	onRestore: (asset: ProjectAsset) => void;
}) {
	const { t, plural } = useI18n();

	const rows: AssetRow[] = [
		...folders.map((folder): AssetRow => ({ kind: 'folder' as const, folder })),
		...items.map((asset): AssetRow => ({ kind: 'asset' as const, asset })),
	];

	const tableSort: DataTableSort = {
		key: assetSortField(sort),
		direction: assetSortDirection(sort),
		onSort: (key) => onSortField(key as AssetSortField),
		label: (header) => t('assets.sort.byColumn', { column: header }),
	};

	const columns: Column<AssetRow>[] = [
		{
			key: 'name',
			header: t('assets.column.name'),
			sortKey: AssetSortField.Name,
			width: '46%',
			render: (row) =>
				row.kind === 'folder' ? (
					<div className="flex items-center gap-2.5">
						<span className="flex h-7 w-9 shrink-0 items-center justify-center rounded-sm border border-border-strong bg-surface-2">
							<Folder className="h-4 w-4 text-text-3" />
						</span>
						<div className="min-w-0">
							<div className="truncate font-medium text-text-1" title={row.folder.path}>
								{row.folder.name}
							</div>
							<div className="text-[11px] text-text-3 md:hidden">
								{t('assets.folderType')} ·{' '}
								{plural('assets.files', row.folder.count, { count: row.folder.count })}
							</div>
						</div>
					</div>
				) : (
					<div className="flex items-center gap-2.5">
						<RowPreview asset={row.asset} />
						<div className="min-w-0">
							<div
								className={`truncate font-medium ${
									row.asset.archived_at != null ? 'text-text-3' : 'text-text-1'
								}`}
								title={row.asset.original_filename}
							>
								{assetBasename(row.asset.original_filename)}
								{row.asset.archived_at != null && (
									<span className="ml-1.5 align-[1px]">
										<ArchivedBadge />
									</span>
								)}
							</div>
							{/* What the three collapsed columns say, on one line. */}
							<div className="text-[11px] text-text-3 md:hidden">
								{assetTypeLabel(row.asset.original_filename)} · {formatBytes(row.asset.byte_size)} ·{' '}
								<RelativeTime iso={row.asset.created_at} />
							</div>
						</div>
					</div>
				),
		},
		{
			key: 'type',
			header: t('assets.column.type'),
			sortKey: AssetSortField.Type,
			hideOnMobile: true,
			width: '12%',
			render: (row) =>
				row.kind === 'folder' ? (
					<span className="text-text-3">{t('assets.folderType')}</span>
				) : (
					<span className="font-mono text-[11.5px] text-text-2">
						{assetTypeLabel(row.asset.original_filename)}
					</span>
				),
		},
		{
			key: 'size',
			header: t('assets.column.size'),
			sortKey: AssetSortField.Size,
			hideOnMobile: true,
			alignRight: true,
			width: '13%',
			render: (row) => (
				<span className="tabular-nums text-text-2">
					{row.kind === 'folder'
						? plural('assets.files', row.folder.count, { count: row.folder.count })
						: formatBytes(row.asset.byte_size)}
				</span>
			),
		},
		{
			key: 'modified',
			header: t('assets.column.modified'),
			sortKey: AssetSortField.Modified,
			hideOnMobile: true,
			width: '17%',
			render: (row) =>
				row.kind === 'folder' ? (
					<span className="text-text-3">-</span>
				) : (
					// `created_at` is bumped to now() on every overwrite, so this reads
					// as the last time the asset changed. Exact timestamp on hover/tap.
					<RelativeTime
						iso={row.asset.created_at}
						className="cursor-help text-text-2"
						testId="asset-updated"
					/>
				),
		},
		{
			key: 'actions',
			header: '',
			className: 'w-0 whitespace-nowrap',
			render: (row) =>
				row.kind === 'folder' ? null : (
					// Hover-revealed on a pointer device so a resting list stays quiet;
					// always visible where there is no hover to reveal them with.
					// Class order mirrors the composer's hover-revealed actions: the
					// `hover:hover` opt-out first, the reveals after it.
					<div
						data-testid="asset-row-actions"
						className="flex justify-end opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100"
					>
						<AssetActions
							asset={row.asset}
							onDelete={() => onDelete(row.asset)}
							onMove={() => onMove(row.asset)}
							onArchive={() => onArchive(row.asset)}
							onRestore={() => onRestore(row.asset)}
						/>
					</div>
				),
		},
	];

	return (
		<DataTable
			columns={columns}
			data={rows}
			sort={tableSort}
			hideHeaderOnMobile
			rowKey={(row) => (row.kind === 'folder' ? `folder:${row.folder.path}` : row.asset.id)}
			// A row's DOM id doubles as the deep-link anchor and as what tests and
			// `focusedRowId` address it by, so it is keyed on the path the URL
			// carries rather than on the asset's UUID.
			getRowId={(row) =>
				assetRowId(row.kind === 'folder' ? row.folder.path : row.asset.original_filename)
			}
			focusedRowId={focusFile ? assetRowId(focusFile) : undefined}
			rowClassName={() => 'group/row'}
			onRowClick={(row) =>
				row.kind === 'folder' ? onOpenFolder(row.folder.path) : onView(row.asset)
			}
		/>
	);
}

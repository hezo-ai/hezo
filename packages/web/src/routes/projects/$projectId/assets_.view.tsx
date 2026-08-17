import {
	ArchiveFilter,
	assetFolder,
	isArchiveFilter,
	isTextReviewableAssetMime,
} from '@hezo/shared';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
	ChevronLeft,
	ChevronRight,
	Download,
	ExternalLink,
	Image as ImageIcon,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { AssetReviewPanel } from '../../../components/asset-review/asset-review-panel';
import { AssetViewerBody } from '../../../components/asset-review/asset-viewer-body';
import { ArchivedBadge } from '../../../components/ui/archived-badge';
import { Breadcrumb, type BreadcrumbSegment } from '../../../components/ui/breadcrumb';
import { EmptyState } from '../../../components/ui/empty-state';
import { NameSwitcherButton } from '../../../components/ui/name-switcher-button';
import { ResizableSplit } from '../../../components/ui/resizable-split';
import { Tooltip } from '../../../components/ui/tooltip';
import {
	useAssetReviewComments,
	useClearAssetReviewComments,
	useCreateAssetReviewComment,
	useDeleteAssetReviewComment,
	useUpdateAssetReviewComment,
} from '../../../hooks/use-asset-review';
import { useProjectAssets } from '../../../hooks/use-project-assets';
import { folderCrumbs } from '../../../lib/asset-folders';
import type { ReviewAnchor } from '../../../lib/doc-review-selection';

interface AssetViewSearch {
	/** The asset's full path (`original_filename`), e.g. `launch/hero.png`. */
	file?: string;
	/** Carried back to the grid so its archive filter survives the round trip. */
	filter?: ArchiveFilter;
}

/**
 * The asset viewer: a split-pane page with the asset content on the left
 * (scaled per type) and its review comments on the right. The right pane is a
 * resizable column at lg+ and a chevron-toggled slide-in drawer below (the
 * task page's side-panel pattern). This page is the canonical in-app link
 * target for an asset — raw view stays reachable via "Open raw".
 */
function AssetViewerPage() {
	const { projectId } = Route.useParams();
	const { file, filter } = Route.useSearch();
	const navigate = useNavigate();
	const { data: assets, isLoading } = useProjectAssets(projectId);
	const asset = file ? assets?.find((a) => a.original_filename === file) : undefined;
	const filePath = file ?? null;

	// Hooks run unconditionally; the query holds off until the asset resolves
	// (`enabled`), and the mutations are only reachable once it has.
	const { data: comments } = useAssetReviewComments(projectId, filePath, asset?.id);
	const create = useCreateAssetReviewComment(projectId, file ?? '', asset?.id ?? '');
	const update = useUpdateAssetReviewComment(projectId, file ?? '', asset?.id ?? '');
	const remove = useDeleteAssetReviewComment(projectId, file ?? '', asset?.id ?? '');
	const clear = useClearAssetReviewComments(projectId, file ?? '', asset?.id ?? '');

	const [activeId, setActiveId] = useState<string | null>(null);
	const [panelOpen, setPanelOpen] = useState(false);

	const { mutateAsync: createAsync } = create;
	const assetSha256 = asset?.sha256;
	const onCreateAnchored = useCallback(
		async (anchor: ReviewAnchor, text: string) => {
			await createAsync({
				quote: anchor.quote,
				occurrence: anchor.occurrence,
				comment: text,
				assetSha256,
			});
		},
		[createAsync, assetSha256],
	);
	const onCreateWholeAsset = useCallback(
		async (text: string) => {
			await createAsync({ comment: text, assetSha256 });
		},
		[createAsync, assetSha256],
	);
	const { mutate: updateMutate } = update;
	const onUpdate = useCallback(
		(commentId: string, text: string) => updateMutate({ commentId, comment: text }),
		[updateMutate],
	);
	const { mutate: removeMutate } = remove;
	const onDelete = useCallback((commentId: string) => removeMutate({ commentId }), [removeMutate]);

	if (isLoading) {
		return <div className="py-4 text-[13px] text-text-2">Loading...</div>;
	}
	if (!file || !asset) {
		return (
			<EmptyState
				icon={<ImageIcon className="h-10 w-10" />}
				title="Asset not found"
				description="It may have been renamed, moved, or deleted."
				action={
					<Link
						to="/projects/$projectId/assets"
						params={{ projectId }}
						className="text-[13px] font-medium text-accent-soft-fg hover:underline"
					>
						Back to assets
					</Link>
				}
			/>
		);
	}

	const readOnly = asset.archived_at != null;
	const textAnchored = isTextReviewableAssetMime(asset.content_type);
	const basename = file.split('/').pop() ?? file;
	// `?download=1` makes the serve route send `Content-Disposition: attachment`,
	// so any asset (including an inline-rendered image) is saved rather than
	// opened. The signed `asset.url` already carries `?exp&sig`, so append with `&`.
	const downloadUrl = `${asset.url}${asset.url.includes('?') ? '&' : '?'}download=1`;
	const folder = assetFolder(file);
	const gridSearch = filter ? { filter } : {};
	const crumbs: BreadcrumbSegment[] = [
		{
			key: '',
			label: 'Assets',
			onNavigate: () =>
				navigate({ to: '/projects/$projectId/assets', params: { projectId }, search: gridSearch }),
		},
		...folderCrumbs(folder).map((c) => ({
			key: c.path,
			label: c.name,
			onNavigate: () =>
				navigate({
					to: '/projects/$projectId/assets',
					params: { projectId },
					search: { folder: c.path, ...gridSearch },
				}),
		})),
		{ key: file, label: file.split('/').pop() ?? file },
	];

	return (
		<div data-testid="asset-viewer">
			<div className="mb-4 flex flex-wrap items-center justify-between gap-2">
				<div className="flex min-h-[26px] min-w-0 items-center gap-2">
					<Breadcrumb segments={crumbs} data-testid="asset-viewer-breadcrumb" />
					{readOnly && <ArchivedBadge />}
					{assets && assets.length > 1 && (
						<NameSwitcherButton
							label="Switch asset"
							testId="asset-switch"
							value={file ?? null}
							onSelect={(next) =>
								navigate({
									to: '/projects/$projectId/assets/view',
									params: { projectId },
									search: { file: next, ...(filter ? { filter } : {}) },
								})
							}
							options={assets.map((a) => ({
								value: a.original_filename,
								label: a.original_filename.split('/').pop() ?? a.original_filename,
								description: assetFolder(a.original_filename) || undefined,
							}))}
							searchPlaceholder="Search assets…"
							emptyLabel="No assets"
						/>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Tooltip content="Download this file">
						<a
							href={downloadUrl}
							download={basename}
							className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[12px] font-medium text-text-2 transition-colors hover:border-border-strong hover:text-text-1"
							aria-label="Download this file"
							data-testid="asset-viewer-download"
						>
							<Download className="h-3.5 w-3.5" />
							Download
						</a>
					</Tooltip>
					<Tooltip content="Open raw in new tab">
						<a
							href={asset.url}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-[12px] font-medium text-text-2 transition-colors hover:border-border-strong hover:text-text-1"
							aria-label="Open raw in new tab"
							data-testid="asset-viewer-raw"
						>
							<ExternalLink className="h-3.5 w-3.5" />
							Open raw
						</a>
					</Tooltip>
				</div>
			</div>

			<ResizableSplit
				side="right"
				storageKey="hezo:asset-review-panel-width"
				defaultTrackClass="lg:grid-cols-[1fr_320px] xl:grid-cols-[1fr_380px]"
				panel={
					<>
						{/* Review panel. Mobile: a fixed right-side drawer toggled by the
						    chevron. Desktop: a plain block filling the resizable grid cell,
						    sticky inside its own scroll area. */}
						<div
							data-testid="asset-review-drawer"
							className={`fixed top-0 right-0 z-40 h-full w-[300px] max-w-[85vw] overflow-y-auto bg-surface p-4 shadow-xl transition-transform duration-200 ${
								panelOpen ? 'translate-x-0' : 'translate-x-full'
							} lg:static lg:z-auto lg:h-auto lg:w-auto lg:max-w-none lg:translate-x-0 lg:overflow-visible lg:p-0 lg:shadow-none`}
						>
							{/* Capped at the shell scroller's visible area
						    (`--shell-scrollport-h`, measured on <main> in __root.tsx)
						    less the `top-4` offset and a matching gap at the bottom.
						    The old `100vh - 2rem` left room for those two gaps but
						    never subtracted the app header, so the rail overhung the
						    fold by the header's height on every page. */}
							<div className="lg:sticky lg:top-4 lg:max-h-[calc(var(--shell-scrollport-h)-2rem)] lg:overflow-y-auto">
								<AssetReviewPanel
									projectId={projectId}
									file={file}
									asset={asset}
									readOnly={readOnly}
									textAnchored={textAnchored}
									comments={comments}
									creating={create.isPending}
									activeId={activeId}
									onActiveIdChange={setActiveId}
									onCreateWholeAsset={onCreateWholeAsset}
									onUpdate={onUpdate}
									onDelete={onDelete}
									onClearAll={async () => {
										await clear.mutateAsync();
									}}
								/>
							</div>
						</div>
					</>
				}
				aside={
					<>
						{/* Mobile pull-in for the review panel - same affordance as the task
						    page's side rail: edge chevron + scrim, hidden at lg+. */}
						<button
							type="button"
							onClick={() => setPanelOpen((o) => !o)}
							data-testid="asset-review-toggle"
							aria-label={panelOpen ? 'Collapse review comments' : 'Expand review comments'}
							aria-expanded={panelOpen}
							className="lg:hidden fixed right-0 top-1/2 -translate-y-1/2 z-50 h-12 w-7 rounded-l-md border border-r-0 border-border bg-surface text-text-2 hover:text-text-1 shadow-md flex items-center justify-center"
						>
							{panelOpen ? (
								<ChevronRight className="w-4 h-4" />
							) : (
								<ChevronLeft className="w-4 h-4" />
							)}
						</button>
						{panelOpen && (
							<button
								type="button"
								aria-label="Close review comments"
								onClick={() => setPanelOpen(false)}
								className="lg:hidden fixed inset-0 z-40 bg-[var(--overlay)] cursor-default"
							/>
						)}
					</>
				}
			>
				<div className="min-w-0">
					<AssetViewerBody
						projectId={projectId}
						asset={asset}
						readOnly={readOnly}
						review={{
							comments,
							saving: create.isPending,
							activeId,
							onActiveIdChange: setActiveId,
							onCreate: onCreateAnchored,
							onUpdate,
							onDelete,
						}}
					/>
				</div>
			</ResizableSplit>
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/assets_/view')({
	validateSearch: (search: Record<string, unknown>): AssetViewSearch => ({
		file: typeof search.file === 'string' ? search.file : undefined,
		filter:
			isArchiveFilter(search.filter) && search.filter !== ArchiveFilter.Active
				? search.filter
				: undefined,
	}),
	component: AssetViewerPage,
});

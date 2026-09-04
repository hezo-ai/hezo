import {
	Archive,
	ArchiveRestore,
	ArrowLeft,
	ExternalLink,
	FileText,
	History,
	Info,
	Loader2,
	PanelLeftClose,
	PanelLeftOpen,
	Pencil,
	Plus,
	Search,
	Trash2,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { readStored, writeStored } from '../lib/safe-storage';
import { DocumentDownloadMenu } from './document-download-menu';
import { DocumentBody } from './document-review/document-body';
import type { DocMetadata } from './document-review/document-metadata-banner';
import { ReviewToolbarActions } from './document-review/review-toolbar-actions';
import { MentionTextarea } from './mention-textarea';
import { ArchivedBadge } from './ui/archived-badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { EmptyState } from './ui/empty-state';
import { Input } from './ui/input';
import { NameSwitcherButton } from './ui/name-switcher-button';
import { RelativeTime } from './ui/relative-time';
import { Tooltip } from './ui/tooltip';

/** Remembers the doc-list collapse choice across documents and visits. */
const LIST_COLLAPSED_KEY = 'hezo:doc-list-collapsed';

export interface DocItem {
	key: string;
	label: ReactNode;
	/** One-line "what this is" summary, shown under the label. Omit for none. */
	description?: ReactNode;
	meta?: ReactNode;
	pinned?: boolean;
	canDelete?: boolean;
	/** Soft-deleted: the row renders muted with an "Archived" chip. */
	archived?: boolean;
}

interface DocsLibraryProps {
	items: DocItem[];
	/**
	 * The full item list for the header "switch document" search — unfiltered by
	 * the archive filter, so the switcher can jump to any document by name.
	 * Defaults to `items` when omitted.
	 */
	allItems?: DocItem[];
	isLoadingList?: boolean;
	selectedKey: string | null;
	onSelect: (key: string | null) => void;

	docContent: string | null | undefined;
	isLoadingDoc?: boolean;
	/** Heading shown for the loaded doc; falls back to the items entry or selectedKey. */
	docTitle?: ReactNode;

	/**
	 * The selected doc's description. `undefined` means the doc type has
	 * no description (e.g. the repo-backed AGENTS.md) — the description block and
	 * its editor are hidden. `''` is a project doc with none set yet: view mode
	 * shows nothing, edit mode shows the input with a placeholder.
	 */
	docDescription?: string;

	onSave: (content: string, description?: string) => Promise<void> | void;
	isSaving?: boolean;
	onDelete?: () => Promise<void> | void;

	/**
	 * Archival (soft delete) for the selected doc. When `archivedInfo` is set the
	 * doc is archived: the viewer shows a banner with Restore, hides Edit (an
	 * archived doc is read-only), and exposes Delete (the hard delete) — the
	 * two-step delete flow. When null/undefined and `onArchive` is set, the
	 * toolbar offers Archive in place of Delete.
	 */
	archivedInfo?: { archivedAt: string; archivedByName?: string | null } | null;
	onArchive?: () => void;
	onRestore?: () => void;
	isArchiveToggling?: boolean;

	onNewDoc?: () => void;
	isCreating?: boolean;
	newForm?: ReactNode;

	/** Rendered between the search row and the list — e.g. the archive FilterPills. */
	listExtras?: ReactNode;

	/** When it returns a URL for the selected doc, a button opens it in a new tab. */
	getPopOutUrl?: (key: string) => string | null;

	viewerExtras?: ReactNode;
	/** Banner rendered above the selected doc (view and edit), e.g. for protected docs. */
	viewerBanner?: ReactNode;

	/**
	 * Review-comment support for the selected doc (view mode only). Set for real
	 * project docs — never for the repo-backed AGENTS.md entry, which has no
	 * document row to hang comments on. Requires projectId/projectSlug.
	 */
	review?: { filename: string; docUpdatedAt?: string } | null;

	/** Structured metadata banner facts for the selected doc (omit for AGENTS.md). */
	docMeta?: DocMetadata;
	/** Rendered above the metadata banner in view mode — e.g. the "viewing revision" banner. */
	bodyBanner?: ReactNode;
	/** Opens the revision-history dialog; when set, a History button shows in the toolbar. */
	onShowHistory?: () => void;
	/**
	 * Open the selected doc directly in edit mode once its content has loaded — set
	 * by the Edit affordance on the read-only preview surfaces, which deep-link here
	 * with `?edit=1`. Honoured a single time per mount (cancelling back to view
	 * won't re-trigger); a no-op for read-only/archived docs.
	 */
	autoEdit?: boolean;
	/** View-only (an older revision is shown): hides Edit/Delete. */
	readOnly?: boolean;

	emptyTitle?: string;
	emptyDescription?: string;

	projectId?: string;
	projectSlug?: string;
}

export function DocsLibrary({
	items,
	allItems,
	isLoadingList,
	selectedKey,
	onSelect,
	docContent,
	isLoadingDoc,
	docTitle,
	docDescription,
	onSave,
	isSaving,
	onDelete,
	archivedInfo,
	onArchive,
	onRestore,
	isArchiveToggling,
	onNewDoc,
	isCreating,
	newForm,
	listExtras,
	getPopOutUrl,
	viewerExtras,
	viewerBanner,
	review,
	docMeta,
	bodyBanner,
	onShowHistory,
	autoEdit,
	readOnly,
	emptyTitle = 'No documents yet',
	emptyDescription,
	projectId,
	projectSlug,
}: DocsLibraryProps) {
	const { t } = useI18n();
	const [mode, setMode] = useState<'view' | 'edit'>('view');
	const [modeKey, setModeKey] = useState<string | null>(selectedKey);
	const [draft, setDraft] = useState('');
	const [descDraft, setDescDraft] = useState('');
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [search, setSearch] = useState('');
	const [listCollapsed, setListCollapsed] = useState(() => readStored(LIST_COLLAPSED_KEY) === '1');
	const prevModeRef = useRef<'view' | 'edit'>('view');
	const autoEditHonoredRef = useRef(false);

	if (modeKey !== selectedKey) {
		setModeKey(selectedKey);
		setMode('view');
	}

	useEffect(() => {
		if (mode === 'edit' && prevModeRef.current !== 'edit') {
			setDraft(docContent ?? '');
			setDescDraft(docDescription ?? '');
		}
		prevModeRef.current = mode;
	}, [mode, docContent, docDescription]);

	// Honour a deep-linked `?edit=1` once the doc content has loaded: flip into
	// edit mode a single time. Waiting for content (rather than starting in edit)
	// lets the draft-init effect above seed the editor from the loaded text.
	useEffect(() => {
		if (
			autoEdit &&
			!autoEditHonoredRef.current &&
			selectedKey &&
			docContent != null &&
			!readOnly &&
			!archivedInfo
		) {
			autoEditHonoredRef.current = true;
			setMode('edit');
		}
	}, [autoEdit, selectedKey, docContent, readOnly, archivedInfo]);

	const showNewForm = isCreating && !!newForm;
	const selectedItem = selectedKey ? items.find((it) => it.key === selectedKey) : undefined;
	const showRightPane = showNewForm || selectedKey;
	const popOutUrl = selectedKey && getPopOutUrl ? getPopOutUrl(selectedKey) : null;
	// The collapse only applies while a document is open — its toolbar hosts the
	// only expand control, so with nothing selected (empty state, new-doc form)
	// the list must stay visible or there'd be no way to pick a document.
	const collapsed = listCollapsed && !!selectedKey && !showNewForm;

	function toggleList() {
		setListCollapsed((prev) => {
			const next = !prev;
			writeStored(LIST_COLLAPSED_KEY, next ? '1' : '0');
			return next;
		});
	}

	// Filter on the visible label when it's a plain string; fall back to the key
	// (typically the filename) for rich labels.
	const query = search.trim().toLowerCase();
	const visibleItems = query
		? items.filter((item) => {
				const text = typeof item.label === 'string' ? item.label : item.key;
				return text.toLowerCase().includes(query);
			})
		: items;

	// Options for the header "switch document" search — the full (unfiltered) list
	// so any document is reachable by name regardless of the archive filter.
	const switchOptions = (allItems ?? items).map((item) => ({
		value: item.key,
		label: typeof item.label === 'string' ? item.label : item.key,
	}));

	// A project doc always has a description string (possibly ''); AGENTS.md and
	// other description-less doc types pass `undefined`, which hides the block +
	// editor and omits the field from the save.
	const supportsDescription = docDescription !== undefined;

	async function handleSave() {
		await onSave(draft, supportsDescription ? descDraft.trim() : undefined);
		setMode('view');
	}

	async function handleConfirmDelete() {
		if (!onDelete) return;
		await onDelete();
		onSelect(null);
	}

	return (
		/* minmax(0,1fr) — a bare 1fr track has an `auto` minimum, so wide doc
		   content (tables, code) would push the column past the viewport and
		   side-scroll the doc list out of view instead of scrolling inside the
		   pane. Collapsing animates the list track (and the gap) to zero so the
		   document takes the full content width. */
		<div
			data-testid="docs-library-grid"
			className={`grid grid-cols-1 md:min-h-[500px] md:transition-[grid-template-columns,gap] md:duration-[var(--panel-motion)] md:ease-in-out motion-reduce:md:transition-none ${
				collapsed
					? 'md:grid-cols-[0px_minmax(0,1fr)] md:gap-0'
					: 'md:grid-cols-[240px_minmax(0,1fr)] md:gap-6'
			}`}
		>
			{/* `inert` while collapsed keeps the visually-hidden list out of tab
			    order and the accessibility tree. `overflow-hidden` clips the list
			    during the track animation (it also disables the sticky child, which
			    is moot while hidden); it must NOT apply when expanded or the sticky
			    doc list stops sticking. */}
			<aside
				inert={collapsed}
				data-testid="doc-list-pane"
				className={`min-w-0 md:transition-opacity md:duration-[var(--panel-motion)] md:ease-in-out motion-reduce:md:transition-none ${
					collapsed ? 'md:overflow-hidden md:opacity-0' : 'md:border-r md:border-border md:pr-6'
				} ${showRightPane ? 'hidden md:block' : 'block'}`}
			>
				{/* Sticky on desktop so the doc list stays visible while a long
				    document scrolls. The top offset mirrors the project layout's
				    vertical padding (md:py-5 lg:py-6) so the pinned position
				    preserves the breathing room visible when unscrolled. max-h caps
				    the list at the shell scroller's visible area
				    (`--shell-scrollport-h`, measured on <main> in __root.tsx) less
				    that same top offset, so it never overflows the bottom of <main>.
				    This used to subtract a literal `100vh - 2.5rem` for an app header
				    that has been h-12 for some time, and no shell banner at all. The
				    column is a flex stack: the search header stays fixed while only
				    the list below it scrolls. */}
				<div className="md:sticky md:top-5 lg:top-6 md:max-h-[calc(var(--shell-scrollport-h)-1.25rem)] lg:max-h-[calc(var(--shell-scrollport-h)-1.5rem)] md:flex md:flex-col">
					{/* On mobile the whole page scrolls, so the header pins itself to
					    the shell scroller; on md+ it's a non-scrolling flex row above
					    the list's own scroller. bg-bg so list rows pass cleanly
					    underneath on mobile. */}
					<div className="sticky top-0 z-10 md:static bg-bg pb-3 md:shrink-0">
						<div className="flex items-center gap-2">
							<Input
								type="search"
								aria-label="Filter documents"
								placeholder="Filter..."
								icon={<Search className="w-3.5 h-3.5" />}
								wrapperClassName="flex-1 min-w-0"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
							/>
							{onNewDoc && (
								<Button
									variant="accent"
									size="sm"
									// Icon-only below desktop to keep the narrow doc-list column
									// clear for the filter; the "New" label appears at lg+.
									className="h-8 w-8 shrink-0 px-0 rounded-md lg:w-auto lg:px-2.5"
									onClick={onNewDoc}
									aria-label="New document"
									title="New document"
								>
									<Plus className="w-4 h-4" />
									<span className="hidden lg:inline">New</span>
								</Button>
							)}
						</div>
						{listExtras && <div className="mt-2">{listExtras}</div>}
					</div>

					<div className="md:overflow-y-auto md:min-h-0" data-testid="doc-list-scroller">
						{isLoadingList ? (
							<div className="text-text-2 text-[13px] py-4">{t('common.loading')}</div>
						) : items.length === 0 ? (
							<div className="text-text-2 text-[13px] py-4">No documents</div>
						) : visibleItems.length === 0 ? (
							<div className="text-text-2 text-[13px] py-4">No matching documents</div>
						) : (
							<ul className="flex flex-col gap-0.5">
								{visibleItems.map((item) => {
									const isActive = item.key === selectedKey;
									return (
										<li key={item.key}>
											<button
												type="button"
												onClick={() => onSelect(item.key)}
												className={`w-full text-left px-2 py-1.5 rounded-md transition-colors ${
													isActive
														? 'bg-surface-2 text-text-1'
														: 'text-text-2 hover:bg-surface-2 hover:text-text-1'
												}`}
											>
												<div
													className={`text-[13px] font-medium truncate ${item.archived ? 'text-text-3' : ''}`}
												>
													{item.label}
												</div>
												{item.description && (
													<div className="text-[11.5px] text-text-2 mt-0.5 truncate">
														{item.description}
													</div>
												)}
												{(item.meta || item.archived) && (
													<div className="text-[11px] text-text-3 mt-0.5 flex items-center gap-1.5 min-w-0">
														{item.archived && <ArchivedBadge />}
														<span className="truncate">{item.meta}</span>
													</div>
												)}
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</div>
				</div>
			</aside>

			<section className={showRightPane ? 'block' : 'hidden md:block'}>
				{!showNewForm && selectedKey && (
					<button
						type="button"
						onClick={() => onSelect(null)}
						className="md:hidden inline-flex items-center gap-1 text-sm text-text-2 hover:text-text-1 mb-3"
					>
						<ArrowLeft className="w-3.5 h-3.5" /> Back
					</button>
				)}

				{showNewForm ? (
					newForm
				) : !selectedKey ? (
					<EmptyState
						icon={<FileText className="w-10 h-10" />}
						title={emptyTitle}
						description={emptyDescription}
					/>
				) : isLoadingDoc || docContent == null ? (
					<div className="text-text-2 text-[13px] py-4">{t('common.loading')}</div>
				) : (
					<div className="flex flex-col">
						{viewerBanner}
						{/* Sticky so the document actions (edit / delete / review toolbar)
						    stay reachable while a long document scrolls. It docks to the top
						    of the shell <main> scroller; `bg-bg` matches the content
						    background so scrolled text passes cleanly underneath, and the
						    z-index sits below the review overlays (selection pill z-20,
						    editor z-30) so an open comment editor is never hidden. */}
						{/* `flex-wrap` + the title's `basis-full sm:basis-auto` keep the
						    title on its own full-width first line on mobile, with the
						    action cluster wrapping beneath it - the whole set of icon
						    buttons can't share a 375px line with a readable title, and a
						    `min-w-0` title squeezed by `shrink-0` actions would otherwise
						    collapse to zero width (an invisible heading). Tablet/desktop
						    (`sm:`) restore the original single-line, space-between row. */}
						<div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 mb-4 pt-2 pb-3 bg-bg border-b border-border-subtle">
							<div className="flex items-center gap-1.5 min-w-0 basis-full sm:basis-auto">
								{/* Mobile already swaps to a single pane with its own Back
								    button, so the collapse control is desktop/tablet only. */}
								<span className="hidden md:block shrink-0">
									<Tooltip content={collapsed ? 'Show document list' : 'Hide document list'}>
										<Button
											variant="ghost"
											size="sm"
											className="px-1.5"
											onClick={toggleList}
											aria-expanded={!collapsed}
											aria-label={collapsed ? 'Show document list' : 'Hide document list'}
											data-testid="doc-list-toggle"
										>
											{collapsed ? (
												<PanelLeftOpen className="w-3.5 h-3.5" />
											) : (
												<PanelLeftClose className="w-3.5 h-3.5" />
											)}
										</Button>
									</Tooltip>
								</span>
								<h2 className="text-base font-semibold text-text-1 truncate min-w-0">
									{docTitle ?? selectedItem?.label ?? selectedKey}
								</h2>
								{mode === 'view' && switchOptions.length > 1 && (
									<NameSwitcherButton
										label="Switch document"
										testId="doc-switch"
										value={selectedKey}
										onSelect={(key) => onSelect(key)}
										options={switchOptions}
										searchPlaceholder="Search documents…"
										emptyLabel="No documents"
									/>
								)}
							</div>
							<div className="flex items-center gap-2 shrink-0 ml-auto sm:ml-0">
								{mode === 'view' ? (
									<>
										{review && projectId && (
											<ReviewToolbarActions projectId={projectId} filename={review.filename} />
										)}
										{!readOnly && !archivedInfo && (
											<Button
												variant="ghost"
												size="sm"
												onClick={() => setMode('edit')}
												aria-label={t('common.edit')}
											>
												<Pencil className="w-3.5 h-3.5" />
												<span className="hidden sm:inline">{t('common.edit')}</span>
											</Button>
										)}
										{onShowHistory && (
											<Button
												variant="ghost"
												size="sm"
												onClick={onShowHistory}
												aria-label="Revision history"
												data-testid="doc-history"
											>
												<History className="w-3.5 h-3.5" />
												<span className="hidden sm:inline">History</span>
											</Button>
										)}
										{typeof docContent === 'string' && (
											<DocumentDownloadMenu
												filename={
													typeof docTitle === 'string' ? docTitle : (selectedKey ?? 'document.md')
												}
												content={docContent}
											/>
										)}
										{popOutUrl && (
											<Button
												variant="ghost"
												size="sm"
												onClick={() => window.open(popOutUrl, '_blank', 'noopener')}
												aria-label="Open in new tab"
												data-testid="doc-popout"
											>
												<ExternalLink className="w-3.5 h-3.5" />
											</Button>
										)}
										{/* Active docs offer Archive (reversible, no confirm); the hard
										    delete only appears on archived docs - a two-step flow that
										    keeps the destructive action off the everyday toolbar. */}
										{!readOnly &&
											!archivedInfo &&
											onArchive &&
											selectedItem?.canDelete !== false && (
												<Tooltip content="Archive document">
													<Button
														variant="ghost"
														size="sm"
														onClick={onArchive}
														disabled={isArchiveToggling}
														aria-label="Archive document"
														data-testid="doc-archive"
													>
														<Archive className="w-3.5 h-3.5" />
													</Button>
												</Tooltip>
											)}
										{!readOnly && archivedInfo && onDelete && selectedItem?.canDelete !== false && (
											<Tooltip content="Delete permanently">
												<Button
													variant="ghost"
													size="sm"
													className="text-danger"
													onClick={() => setDeleteOpen(true)}
													aria-label="Delete document"
												>
													<Trash2 className="w-3.5 h-3.5" />
												</Button>
											</Tooltip>
										)}
									</>
								) : (
									<>
										<Button variant="ghost" size="sm" onClick={() => setMode('view')}>
											Cancel
										</Button>
										<Button size="sm" onClick={handleSave} disabled={isSaving}>
											{isSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
											Save
										</Button>
									</>
								)}
							</div>
						</div>

						{mode === 'view' && archivedInfo && (
							<div
								className="flex items-center gap-2.5 rounded-md border border-border bg-surface-2 px-3 py-2.5 mb-4"
								data-testid="doc-archived-banner"
							>
								<Archive className="w-4 h-4 shrink-0 text-text-3" />
								<div className="flex-1 min-w-0 text-[12.5px]">
									<span className="font-semibold text-text-1">This document is archived.</span>{' '}
									<span className="text-text-2">
										Hidden from the Active list and from agents
										{archivedInfo.archivedByName
											? ` - archived by ${archivedInfo.archivedByName}`
											: ''}{' '}
										<RelativeTime iso={archivedInfo.archivedAt} />.
									</span>
								</div>
								{onRestore && (
									<Button
										variant="secondary"
										size="sm"
										onClick={onRestore}
										disabled={isArchiveToggling}
										data-testid="doc-restore"
									>
										{isArchiveToggling ? (
											<Loader2 className="w-3 h-3 animate-spin" />
										) : (
											<ArchiveRestore className="w-3 h-3" />
										)}
										Restore
									</Button>
								)}
							</div>
						)}

						{/* The doc's "what this is" line, above the metadata banner. Only
						    shown when set - an empty description reads as no subtitle. */}
						{mode === 'view' && supportsDescription && docDescription && (
							<p
								className="text-[13px] leading-relaxed text-text-2 mb-4"
								data-testid="doc-description"
							>
								{docDescription}
							</p>
						)}

						{mode === 'view' ? (
							<DocumentBody
								content={docContent || '_(empty)_'}
								projectId={projectId}
								projectSlug={projectSlug}
								meta={docMeta}
								review={review && projectId && projectSlug ? review : null}
								topSlot={bodyBanner}
							/>
						) : (
							<div className="flex flex-col gap-3">
								{supportsDescription && (
									<div className="flex flex-col gap-1">
										<div className="flex items-center gap-1.5">
											<label
												htmlFor="doc-description-input"
												className="text-[11px] font-medium uppercase tracking-wide text-text-3"
											>
												Description
											</label>
											<Tooltip content="An overall summary of what the doc is - 1-2 sentences, not a list of its current contents. Agents fill it in when they write the doc; you can edit it here anytime.">
												<Info
													className="w-3.5 h-3.5 text-text-3"
													aria-label="An overall summary of what the doc is, in 1-2 sentences; agents set it when they write the doc and you can edit it here anytime."
												/>
											</Tooltip>
										</div>
										<Input
											id="doc-description-input"
											value={descDraft}
											onChange={(e) => setDescDraft(e.target.value)}
											placeholder="What this doc is and when to read it (1-2 sentences)"
											data-testid="doc-description-input"
										/>
									</div>
								)}
								<MentionTextarea
									projectId={projectId}
									projectSlug={projectSlug}
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
									className="min-h-[400px] font-mono text-xs"
								/>
							</div>
						)}

						{mode === 'view' && viewerExtras}
					</div>
				)}
			</section>

			<ConfirmDialog
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
				title="Delete this document?"
				description="The document will be permanently removed."
				confirmLabel={t('common.delete')}
				variant="danger"
				onConfirm={handleConfirmDelete}
			/>
		</div>
	);
}

import {
	ArrowLeft,
	ExternalLink,
	FileText,
	History,
	Loader2,
	Pencil,
	Plus,
	Search,
	Trash2,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { DocumentBody } from './document-review/document-body';
import type { DocMetadata } from './document-review/document-metadata-banner';
import { ReviewToolbarActions } from './document-review/review-toolbar-actions';
import { MentionTextarea } from './mention-textarea';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { EmptyState } from './ui/empty-state';
import { Input } from './ui/input';

export interface DocItem {
	key: string;
	label: ReactNode;
	meta?: ReactNode;
	pinned?: boolean;
	canDelete?: boolean;
}

interface DocsLibraryProps {
	items: DocItem[];
	isLoadingList?: boolean;
	selectedKey: string | null;
	onSelect: (key: string | null) => void;

	docContent: string | null | undefined;
	isLoadingDoc?: boolean;
	/** Heading shown for the loaded doc; falls back to the items entry or selectedKey. */
	docTitle?: ReactNode;

	onSave: (content: string) => Promise<void> | void;
	isSaving?: boolean;
	onDelete?: () => Promise<void> | void;

	onNewDoc?: () => void;
	isCreating?: boolean;
	newForm?: ReactNode;

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
	/** View-only (an older revision is shown): hides Edit/Delete. */
	readOnly?: boolean;

	emptyTitle?: string;
	emptyDescription?: string;

	projectId?: string;
	projectSlug?: string;
}

export function DocsLibrary({
	items,
	isLoadingList,
	selectedKey,
	onSelect,
	docContent,
	isLoadingDoc,
	docTitle,
	onSave,
	isSaving,
	onDelete,
	onNewDoc,
	isCreating,
	newForm,
	getPopOutUrl,
	viewerExtras,
	viewerBanner,
	review,
	docMeta,
	bodyBanner,
	onShowHistory,
	readOnly,
	emptyTitle = 'No documents yet',
	emptyDescription,
	projectId,
	projectSlug,
}: DocsLibraryProps) {
	const [mode, setMode] = useState<'view' | 'edit'>('view');
	const [modeKey, setModeKey] = useState<string | null>(selectedKey);
	const [draft, setDraft] = useState('');
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [search, setSearch] = useState('');
	const prevModeRef = useRef<'view' | 'edit'>('view');

	if (modeKey !== selectedKey) {
		setModeKey(selectedKey);
		setMode('view');
	}

	useEffect(() => {
		if (mode === 'edit' && prevModeRef.current !== 'edit') {
			setDraft(docContent ?? '');
		}
		prevModeRef.current = mode;
	}, [mode, docContent]);

	const showNewForm = isCreating && !!newForm;
	const selectedItem = selectedKey ? items.find((it) => it.key === selectedKey) : undefined;
	const showRightPane = showNewForm || selectedKey;
	const popOutUrl = selectedKey && getPopOutUrl ? getPopOutUrl(selectedKey) : null;

	// Filter on the visible label when it's a plain string; fall back to the key
	// (typically the filename) for rich labels.
	const query = search.trim().toLowerCase();
	const visibleItems = query
		? items.filter((item) => {
				const text = typeof item.label === 'string' ? item.label : item.key;
				return text.toLowerCase().includes(query);
			})
		: items;

	async function handleSave() {
		await onSave(draft);
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
		   pane. */
		<div className="grid grid-cols-1 md:grid-cols-[240px_minmax(0,1fr)] md:gap-6 md:min-h-[500px]">
			<aside
				className={`md:border-r md:border-border md:pr-6 ${
					showRightPane ? 'hidden md:block' : 'block'
				}`}
			>
				{/* Sticky on desktop so the doc list stays visible while a long
				    document scrolls. The top offset mirrors the project layout's
				    vertical padding (md:py-5 lg:py-6) so the pinned position
				    preserves the breathing room visible when unscrolled. max-h
				    subtracts the h-10 app header (2.5rem) plus the top offset so
				    the list never overflows the bottom of <main>. The column is a
				    flex stack: the search header stays fixed while only the list
				    below it scrolls. */}
				<div className="md:sticky md:top-5 lg:top-6 md:max-h-[calc(100vh-3.75rem)] lg:max-h-[calc(100vh-4rem)] md:flex md:flex-col">
					{/* On mobile the whole page scrolls, so the header pins itself to
					    the shell scroller; on md+ it's a non-scrolling flex row above
					    the list's own scroller. bg-bg so list rows pass cleanly
					    underneath on mobile. */}
					<div className="sticky top-0 z-10 md:static flex items-center gap-2 bg-bg pb-3 md:shrink-0">
						<Input
							type="search"
							aria-label="Search documents"
							placeholder="Search documents"
							icon={<Search className="w-3.5 h-3.5" />}
							className="flex-1 min-w-0"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
						{onNewDoc && (
							<Button
								variant="outline"
								size="sm"
								className="h-8 w-8 shrink-0 px-0 rounded-md"
								onClick={onNewDoc}
								aria-label="New document"
								title="New document"
							>
								<Plus className="w-4 h-4" />
							</Button>
						)}
					</div>

					<div className="md:overflow-y-auto md:min-h-0">
						{isLoadingList ? (
							<div className="text-text-2 text-[13px] py-4">Loading...</div>
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
												<div className="text-[13px] font-medium truncate">{item.label}</div>
												{item.meta && (
													<div className="text-[11px] text-text-3 mt-0.5 truncate">{item.meta}</div>
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
					<div className="text-text-2 text-[13px] py-4">Loading...</div>
				) : (
					<div className="flex flex-col">
						{viewerBanner}
						{/* Sticky so the document actions (edit / delete / review toolbar)
						    stay reachable while a long document scrolls. It docks to the top
						    of the shell <main> scroller; `bg-bg` matches the content
						    background so scrolled text passes cleanly underneath, and the
						    z-index sits below the review overlays (selection pill z-20,
						    editor z-30) so an open comment editor is never hidden. */}
						<div className="sticky top-0 z-10 flex items-center justify-between gap-2 mb-4 pt-2 pb-3 bg-bg border-b border-border-subtle">
							<h2 className="text-base font-semibold text-text-1 truncate">
								{docTitle ?? selectedItem?.label ?? selectedKey}
							</h2>
							<div className="flex items-center gap-2 shrink-0">
								{mode === 'view' ? (
									<>
										{review && projectId && (
											<ReviewToolbarActions projectId={projectId} filename={review.filename} />
										)}
										{!readOnly && (
											<Button
												variant="ghost"
												size="sm"
												onClick={() => setMode('edit')}
												aria-label="Edit"
											>
												<Pencil className="w-3.5 h-3.5" />
												<span className="hidden sm:inline">Edit</span>
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
										{!readOnly && onDelete && selectedItem?.canDelete !== false && (
											<Button
												variant="ghost"
												size="sm"
												className="text-danger"
												onClick={() => setDeleteOpen(true)}
												aria-label="Delete document"
											>
												<Trash2 className="w-3.5 h-3.5" />
											</Button>
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
							<MentionTextarea
								projectId={projectId}
								projectSlug={projectSlug}
								value={draft}
								onChange={(e) => setDraft(e.target.value)}
								className="min-h-[400px] font-mono text-xs"
							/>
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
				confirmLabel="Delete"
				variant="danger"
				onConfirm={handleConfirmDelete}
			/>
		</div>
	);
}

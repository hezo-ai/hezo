import {
	ArchiveFilter,
	isArchiveFilter,
	isMarkdownDocSlug,
	matchesArchiveFilter,
} from '@hezo/shared';
import { createFileRoute } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type DocItem, DocsLibrary } from '../../../components/docs-library';
import { RevisionHistoryDialog } from '../../../components/document-review/revision-history-dialog';
import { ViewingRevisionBanner } from '../../../components/document-review/viewing-revision-banner';
import { MarkdownEditor } from '../../../components/markdown-editor';
import { Button } from '../../../components/ui/button';
import { FilterPills } from '../../../components/ui/filter-pills';
import { Input } from '../../../components/ui/input';
import {
	useArchiveProjectDoc,
	useDeleteProjectDoc,
	useProjectAgentsMd,
	useProjectDoc,
	useProjectDocRevisions,
	useProjectDocs,
	useRestoreProjectDocRevision,
	useUpdateProjectAgentsMd,
	useUpdateProjectDoc,
} from '../../../hooks/use-project-docs';
import { docPreviewPath } from '../../../lib/doc-preview';
import { buildDocVersionHistory, type DocVersionEntry } from '../../../lib/doc-version-history';
import { formatDateTime, formatRelativeTime } from '../../../lib/format-date';

const AGENTS_MD_KEY = '__agents_md__';

interface DocumentsSearch {
	file?: string;
	/** Archive filter — absent means the default Active view. */
	filter?: ArchiveFilter;
	/** Deep-link from a preview surface's Edit button: open `file` in edit mode. */
	edit?: boolean;
	/** Deep-link from a preview surface's History button: open the revision dialog. */
	history?: boolean;
}

function ProjectDocumentsPage() {
	const { projectId } = Route.useParams();
	const { file, filter = ArchiveFilter.Active, edit, history } = Route.useSearch();
	const navigate = Route.useNavigate();

	const { data: docs, isLoading: isLoadingList } = useProjectDocs(projectId);
	const { data: agentsMd } = useProjectAgentsMd(projectId);

	const updateDoc = useUpdateProjectDoc(projectId);
	const deleteDoc = useDeleteProjectDoc(projectId);
	const archiveDoc = useArchiveProjectDoc(projectId);
	const updateAgentsMd = useUpdateProjectAgentsMd(projectId);

	const [isCreating, setIsCreating] = useState(false);

	const isAgentsMd = file === AGENTS_MD_KEY;
	const filenameForFetch = file && !isAgentsMd ? file : null;
	const { data: doc, isLoading: isLoadingDoc } = useProjectDoc(projectId, filenameForFetch);
	const { data: revisions } = useProjectDocRevisions(projectId, filenameForFetch);
	const restore = useRestoreProjectDocRevision(projectId, file ?? '');

	// Which past version (if any) is being viewed, and whether the history dialog is open.
	const [viewingRevision, setViewingRevision] = useState<DocVersionEntry | null>(null);
	const [historyOpen, setHistoryOpen] = useState(false);
	const historyAutoOpenedRef = useRef(false);
	// Return to the latest version whenever the selected file changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only on file switch
	useEffect(() => {
		setViewingRevision(null);
		setHistoryOpen(false);
	}, [file]);

	// Honour a deep-linked `?history=1` from a preview surface once: open the
	// revision dialog for the selected doc. Declared after the file-reset effect so
	// it wins on the initial mount, and latched so closing the dialog is final.
	useEffect(() => {
		if (history && !historyAutoOpenedRef.current && file && !isAgentsMd) {
			historyAutoOpenedRef.current = true;
			setHistoryOpen(true);
		}
	}, [history, file, isAgentsMd]);

	const versionEntries = useMemo(
		() => (doc && !isAgentsMd ? buildDocVersionHistory(doc, revisions) : []),
		[doc, revisions, isAgentsMd],
	);

	// AGENTS.md is a repo file, not a project doc — it is pinned into every
	// filter view and can never be archived.
	const items = useMemo<DocItem[]>(() => {
		const list: DocItem[] = [];
		if (agentsMd) {
			list.push({
				key: AGENTS_MD_KEY,
				label: 'AGENTS.md',
				meta: 'Repo file',
				pinned: true,
				canDelete: false,
			});
		}
		for (const d of docs ?? []) {
			if (!matchesArchiveFilter(d.archived_at, filter)) continue;
			list.push({
				key: d.filename,
				label: d.filename,
				description: d.description || undefined,
				archived: d.archived_at != null,
				meta: (
					<>
						Updated{' '}
						<time dateTime={d.updated_at} title={formatDateTime(d.updated_at)}>
							{formatRelativeTime(d.updated_at)}
						</time>
					</>
				),
			});
		}
		return list;
	}, [agentsMd, docs, filter]);

	// The full item list for the header "switch document" search — unfiltered by
	// the archive filter, so the switcher can jump to any document (including
	// archived ones) by name.
	const allItems = useMemo<DocItem[]>(() => {
		const list: DocItem[] = [];
		if (agentsMd) {
			list.push({ key: AGENTS_MD_KEY, label: 'AGENTS.md', pinned: true, canDelete: false });
		}
		for (const d of docs ?? []) {
			list.push({ key: d.filename, label: d.filename, archived: d.archived_at != null });
		}
		return list;
	}, [agentsMd, docs]);

	const counts = useMemo(() => {
		const all = docs?.length ?? 0;
		const archived = docs?.filter((d) => d.archived_at != null).length ?? 0;
		return { all, archived, active: all - archived };
	}, [docs]);

	function setFilter(next: ArchiveFilter) {
		navigate({
			search: (prev) => ({
				...(prev as DocumentsSearch),
				filter: next === ArchiveFilter.Active ? undefined : next,
			}),
			replace: true,
		});
	}

	const docContent = isAgentsMd ? (agentsMd?.content ?? null) : (doc?.content ?? null);
	const displayContent = viewingRevision ? viewingRevision.content : docContent;
	const isArchivedDoc = !isAgentsMd && doc?.archived_at != null;
	const docMeta = isAgentsMd
		? undefined
		: viewingRevision
			? {
					createdAt: doc?.created_at,
					updatedAt: viewingRevision.timestamp,
					editorName: viewingRevision.authorName,
					editorType: viewingRevision.authorType,
				}
			: {
					createdAt: doc?.created_at,
					updatedAt: doc?.updated_at,
					editorName: doc?.last_updated_by_name,
					editorType: doc?.last_updated_by_type,
				};

	function selectFile(key: string | null) {
		navigate({
			search: (prev) => ({ ...(prev as DocumentsSearch), file: key ?? undefined }),
			replace: true,
		});
		setIsCreating(false);
	}

	async function handleSave(content: string, description?: string) {
		if (!file) return;
		if (isAgentsMd) {
			await updateAgentsMd.mutateAsync(content);
		} else {
			await updateDoc.mutateAsync({ filename: file, content, description });
		}
	}

	async function handleDelete() {
		if (!file || isAgentsMd) return;
		await deleteDoc.mutateAsync(file);
	}

	function handleViewRevision(entry: DocVersionEntry) {
		setViewingRevision(entry.isCurrent ? null : entry);
		setHistoryOpen(false);
	}

	async function handleRestore(revisionNumber: number) {
		await restore.mutateAsync(revisionNumber);
		setViewingRevision(null);
	}

	return (
		<>
			{/* Section header — frames Documents as the team's long-term memory,
			    mirroring the Assets page header. On mobile it hides once a doc is
			    open or the new-doc form is up (single-pane), staying visible on md+
			    where the two-pane layout always shows the list. */}
			<div className={`mb-4 ${!file && !isCreating ? '' : 'hidden md:block'}`}>
				<h1 className="text-base font-semibold text-text-1">Documents</h1>
				<p className="text-[13px] text-text-2">
					Your team's long-term memory — the guidelines, research, and reference material the team
					builds up and returns to across the project.
				</p>
			</div>
			<DocsLibrary
				projectId={projectId}
				projectSlug={projectId}
				items={items}
				allItems={allItems}
				isLoadingList={isLoadingList}
				selectedKey={file ?? null}
				onSelect={selectFile}
				docContent={displayContent}
				isLoadingDoc={isLoadingDoc}
				docTitle={isAgentsMd ? 'AGENTS.md' : (file ?? undefined)}
				docDescription={isAgentsMd ? undefined : (doc?.description ?? '')}
				onSave={handleSave}
				isSaving={updateDoc.isPending || updateAgentsMd.isPending}
				onDelete={handleDelete}
				archivedInfo={
					isArchivedDoc && doc?.archived_at
						? { archivedAt: doc.archived_at, archivedByName: doc.archived_by_name }
						: null
				}
				onArchive={
					file && !isAgentsMd
						? () => archiveDoc.mutate({ filename: file, archived: true })
						: undefined
				}
				onRestore={
					file && !isAgentsMd
						? () => archiveDoc.mutate({ filename: file, archived: false })
						: undefined
				}
				isArchiveToggling={archiveDoc.isPending}
				listExtras={
					<FilterPills
						stretch
						className=""
						options={[
							{ value: ArchiveFilter.Active, label: 'Active', count: counts.active },
							{ value: ArchiveFilter.Archived, label: 'Archived', count: counts.archived },
							{ value: ArchiveFilter.All, label: 'All', count: counts.all },
						]}
						value={filter}
						onChange={setFilter}
					/>
				}
				onNewDoc={() => {
					setIsCreating(true);
					navigate({
						search: (prev) => ({ ...(prev as DocumentsSearch), file: undefined }),
						replace: true,
					});
				}}
				isCreating={isCreating}
				getPopOutUrl={(key) => (key === AGENTS_MD_KEY ? null : docPreviewPath(projectId, key))}
				newForm={
					<NewProjectDocForm
						projectId={projectId}
						projectSlug={projectId}
						onCancel={() => setIsCreating(false)}
						onCreate={async (filename, content, description) => {
							await updateDoc.mutateAsync({ filename, content, description });
							setIsCreating(false);
							navigate({
								search: (prev) => ({ ...(prev as DocumentsSearch), file: filename }),
								replace: true,
							});
						}}
						isPending={updateDoc.isPending}
					/>
				}
				review={
					file && !isAgentsMd && !viewingRevision && !isArchivedDoc
						? { filename: file, docUpdatedAt: doc?.updated_at }
						: null
				}
				docMeta={docMeta}
				bodyBanner={
					viewingRevision && viewingRevision.revisionNumber !== null ? (
						<ViewingRevisionBanner
							revisionNumber={viewingRevision.revisionNumber}
							timestamp={viewingRevision.timestamp}
							authorName={viewingRevision.authorName}
							onViewLatest={() => setViewingRevision(null)}
						/>
					) : undefined
				}
				onShowHistory={file && !isAgentsMd ? () => setHistoryOpen(true) : undefined}
				autoEdit={!!edit}
				readOnly={!!viewingRevision}
				emptyTitle="Select a document"
				emptyDescription="Choose a project document from the list to view or edit it."
			/>
			{file && !isAgentsMd && (
				<RevisionHistoryDialog
					open={historyOpen}
					onOpenChange={setHistoryOpen}
					filename={file}
					entries={versionEntries}
					projectId={projectId}
					projectSlug={projectId}
					viewingRevision={viewingRevision?.revisionNumber ?? null}
					onView={handleViewRevision}
					// Archived docs are read-only — restore the doc itself first.
					onRestore={isArchivedDoc ? undefined : handleRestore}
					isRestoring={restore.isPending}
				/>
			)}
		</>
	);
}

function NewProjectDocForm({
	projectId,
	projectSlug,
	onCancel,
	onCreate,
	isPending,
}: {
	projectId: string;
	projectSlug: string;
	onCancel: () => void;
	onCreate: (filename: string, content: string, description: string) => Promise<void>;
	isPending: boolean;
}) {
	const [filename, setFilename] = useState('');
	const [description, setDescription] = useState('');
	const [content, setContent] = useState('');
	const [error, setError] = useState<string | null>(null);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const name = filename.trim();
		if (!isMarkdownDocSlug(name)) {
			setError(
				'Filename must end with .md and contain only letters, digits, dot, dash, underscore',
			);
			return;
		}
		setError(null);
		await onCreate(name, content, description.trim());
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-2xl">
			<h2 className="text-base font-semibold">New document</h2>
			<Input
				label="Filename"
				placeholder="notes.md"
				value={filename}
				onChange={(e) => setFilename(e.target.value)}
				required
			/>
			<Input
				label="Description"
				placeholder="What this doc is and when to read it"
				value={description}
				onChange={(e) => setDescription(e.target.value)}
			/>
			<MarkdownEditor
				projectId={projectId}
				projectSlug={projectSlug}
				label="Content (Markdown)"
				ariaLabel="Content (Markdown)"
				value={content}
				onChange={setContent}
				className="min-h-[300px] font-mono text-xs"
				previewClassName="min-h-[300px]"
				emptyPreviewText="_(empty)_"
			/>
			{error && <p className="text-sm text-danger">{error}</p>}
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" disabled={!filename.trim() || isPending}>
					{isPending && <Loader2 className="w-4 h-4 animate-spin" />}
					Create
				</Button>
			</div>
		</form>
	);
}

export const Route = createFileRoute('/projects/$projectId/documents')({
	validateSearch: (search: Record<string, unknown>): DocumentsSearch => ({
		file: typeof search.file === 'string' ? search.file : undefined,
		filter:
			isArchiveFilter(search.filter) && search.filter !== ArchiveFilter.Active
				? search.filter
				: undefined,
		// Drop when falsy so the deep-link flags never linger in the URL.
		edit: search.edit === true || search.edit === '1' || search.edit === 'true' ? true : undefined,
		history:
			search.history === true || search.history === '1' || search.history === 'true'
				? true
				: undefined,
	}),
	component: ProjectDocumentsPage,
});

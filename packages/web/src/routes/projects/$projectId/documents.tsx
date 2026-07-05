import { type DocumentStatus, formatDocumentStatus, isMarkdownDocSlug } from '@hezo/shared';
import { createFileRoute } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { type DocItem, DocsLibrary } from '../../../components/docs-library';
import { RevisionHistoryDialog } from '../../../components/document-review/revision-history-dialog';
import { ViewingRevisionBanner } from '../../../components/document-review/viewing-revision-banner';
import { MarkdownEditor } from '../../../components/markdown-editor';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import {
	useDeleteProjectDoc,
	useProjectAgentsMd,
	useProjectDoc,
	useProjectDocRevisions,
	useProjectDocs,
	useRestoreProjectDocRevision,
	useUpdateProjectAgentsMd,
	useUpdateProjectDoc,
	useUpdateProjectDocStatus,
} from '../../../hooks/use-project-docs';
import { docPreviewPath } from '../../../lib/doc-preview';
import { buildDocVersionHistory, type DocVersionEntry } from '../../../lib/doc-version-history';

const AGENTS_MD_KEY = '__agents_md__';

interface DocumentsSearch {
	file?: string;
}

function ProjectDocumentsPage() {
	const { projectId } = Route.useParams();
	const { file } = Route.useSearch();
	const navigate = Route.useNavigate();

	const { data: docs, isLoading: isLoadingList } = useProjectDocs(projectId);
	const { data: agentsMd } = useProjectAgentsMd(projectId);

	const updateDoc = useUpdateProjectDoc(projectId);
	const deleteDoc = useDeleteProjectDoc(projectId);
	const updateAgentsMd = useUpdateProjectAgentsMd(projectId);

	const [isCreating, setIsCreating] = useState(false);

	const isAgentsMd = file === AGENTS_MD_KEY;
	const filenameForFetch = file && !isAgentsMd ? file : null;
	const { data: doc, isLoading: isLoadingDoc } = useProjectDoc(projectId, filenameForFetch);
	const { data: revisions } = useProjectDocRevisions(projectId, filenameForFetch);
	const restore = useRestoreProjectDocRevision(projectId, file ?? '');
	const updateStatus = useUpdateProjectDocStatus(projectId, filenameForFetch);

	// Which past version (if any) is being viewed, and whether the history dialog is open.
	const [viewingRevision, setViewingRevision] = useState<DocVersionEntry | null>(null);
	const [historyOpen, setHistoryOpen] = useState(false);
	// Return to the latest version whenever the selected file changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only on file switch
	useEffect(() => {
		setViewingRevision(null);
		setHistoryOpen(false);
	}, [file]);

	const versionEntries = useMemo(
		() => (doc && !isAgentsMd ? buildDocVersionHistory(doc, revisions) : []),
		[doc, revisions, isAgentsMd],
	);

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
			list.push({
				key: d.filename,
				label: d.filename,
				meta: d.status
					? `${formatDocumentStatus(d.status)} · Updated ${new Date(d.updated_at).toLocaleDateString()}`
					: `Updated ${new Date(d.updated_at).toLocaleDateString()}`,
			});
		}
		return list;
	}, [agentsMd, docs]);

	const docContent = isAgentsMd ? (agentsMd?.content ?? null) : (doc?.content ?? null);
	const displayContent = viewingRevision ? viewingRevision.content : docContent;
	const docMeta = isAgentsMd
		? undefined
		: viewingRevision
			? {
					createdAt: doc?.created_at,
					updatedAt: viewingRevision.timestamp,
					editorName: viewingRevision.authorName,
					editorType: viewingRevision.authorType,
					status: doc?.status,
				}
			: {
					createdAt: doc?.created_at,
					updatedAt: doc?.updated_at,
					editorName: doc?.last_updated_by_name,
					editorType: doc?.last_updated_by_type,
					status: doc?.status,
					onStatusChange: file
						? (status: DocumentStatus) => updateStatus.mutate({ status })
						: undefined,
				};

	function selectFile(key: string | null) {
		navigate({
			search: (prev) => ({ ...(prev as DocumentsSearch), file: key ?? undefined }),
			replace: true,
		});
		setIsCreating(false);
	}

	async function handleSave(content: string) {
		if (!file) return;
		if (isAgentsMd) {
			await updateAgentsMd.mutateAsync(content);
		} else {
			await updateDoc.mutateAsync({ filename: file, content });
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
			<DocsLibrary
				projectId={projectId}
				projectSlug={projectId}
				items={items}
				isLoadingList={isLoadingList}
				selectedKey={file ?? null}
				onSelect={selectFile}
				docContent={displayContent}
				isLoadingDoc={isLoadingDoc}
				docTitle={isAgentsMd ? 'AGENTS.md' : (file ?? undefined)}
				onSave={handleSave}
				isSaving={updateDoc.isPending || updateAgentsMd.isPending}
				onDelete={handleDelete}
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
						onCreate={async (filename, content) => {
							await updateDoc.mutateAsync({ filename, content });
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
					file && !isAgentsMd && !viewingRevision
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
					onRestore={handleRestore}
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
	onCreate: (filename: string, content: string) => Promise<void>;
	isPending: boolean;
}) {
	const [filename, setFilename] = useState('');
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
		await onCreate(name, content);
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
	}),
	component: ProjectDocumentsPage,
});

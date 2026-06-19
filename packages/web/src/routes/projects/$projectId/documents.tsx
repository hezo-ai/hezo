import { CHAT_MEMORY_SLUG, HQ_PROJECT_SLUG, isMarkdownDocSlug } from '@hezo/shared';
import { createFileRoute } from '@tanstack/react-router';
import { Info, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type DocItem, DocsLibrary } from '../../../components/docs-library';
import { MentionTextarea } from '../../../components/mention-textarea';
import { RevisionsPanel } from '../../../components/revisions-panel';
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
} from '../../../hooks/use-project-docs';
import { docPreviewPath } from '../../../lib/doc-preview';

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

	const isHq = projectId === HQ_PROJECT_SLUG;
	const isAgentsMd = file === AGENTS_MD_KEY;
	const filenameForFetch = file && !isAgentsMd ? file : null;
	const { data: doc, isLoading: isLoadingDoc } = useProjectDoc(projectId, filenameForFetch);

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
			// The chatbox memory doc is permanent — never offer to delete it.
			const isChatMemory = isHq && d.filename === CHAT_MEMORY_SLUG;
			list.push({
				key: d.filename,
				label: d.filename,
				meta: `Updated ${new Date(d.updated_at).toLocaleDateString()}`,
				canDelete: isChatMemory ? false : undefined,
			});
		}
		return list;
	}, [agentsMd, docs, isHq]);

	const showChatMemoryBanner = isHq && file === CHAT_MEMORY_SLUG;

	const docContent = isAgentsMd ? (agentsMd?.content ?? null) : (doc?.content ?? null);

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

	return (
		<DocsLibrary
			projectId={projectId}
			projectSlug={projectId}
			items={items}
			isLoadingList={isLoadingList}
			selectedKey={file ?? null}
			onSelect={selectFile}
			docContent={docContent}
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
			viewerExtras={
				file && !isAgentsMd ? (
					<ProjectDocRevisionsPanel projectId={projectId} filename={file} />
				) : null
			}
			viewerBanner={
				showChatMemoryBanner ? (
					<div
						data-testid="chat-memory-banner"
						className="flex items-start gap-2 mb-4 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-[13px] text-text-2"
					>
						<Info className="w-4 h-4 mt-0.5 shrink-0 text-text-3" aria-hidden="true" />
						<span>
							This is the chatbox's persistent memory. Its full contents are injected into every
							chat turn, so anything here is always in the assistant's context. The assistant keeps
							durable operator preferences and standing guidelines here; edit it to correct what it
							remembers. This document cannot be deleted.
						</span>
					</div>
				) : null
			}
			emptyTitle="Select a document"
			emptyDescription="Choose a project document from the list to view or edit it."
		/>
	);
}

function ProjectDocRevisionsPanel({
	projectId,
	filename,
}: {
	projectId: string;
	filename: string;
}) {
	const { data: revisions } = useProjectDocRevisions(projectId, filename);
	const restore = useRestoreProjectDocRevision(projectId, filename);
	return (
		<RevisionsPanel
			revisions={revisions}
			onRestore={(rev) => restore.mutateAsync(rev)}
			isRestoring={restore.isPending}
		/>
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
			<MentionTextarea
				projectId={projectId}
				projectSlug={projectSlug}
				label="Content (Markdown)"
				value={content}
				onChange={(e) => setContent(e.target.value)}
				className="min-h-[300px] font-mono text-xs"
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
	// HQ renders its documents page so the operator can view/edit the chatbox
	// memory (chat-memory.md). Other internal projects don't exist (HQ is the
	// only one), so no redirect is needed.
	component: ProjectDocumentsPage,
});

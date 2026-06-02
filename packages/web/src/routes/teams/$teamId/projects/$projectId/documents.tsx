import { INTERNAL_PROJECT_SLUG, isMarkdownDocSlug } from '@hezo/shared';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type DocItem, DocsLibrary } from '../../../../../components/docs-library';
import { MentionTextarea } from '../../../../../components/mention-textarea';
import { RevisionsPanel } from '../../../../../components/revisions-panel';
import { Button } from '../../../../../components/ui/button';
import { Input } from '../../../../../components/ui/input';
import {
	useDeleteProjectDoc,
	useProjectAgentsMd,
	useProjectDoc,
	useProjectDocRevisions,
	useProjectDocs,
	useRestoreProjectDocRevision,
	useUpdateProjectAgentsMd,
	useUpdateProjectDoc,
} from '../../../../../hooks/use-project-docs';
import { docPreviewPath } from '../../../../../lib/doc-preview';

const AGENTS_MD_KEY = '__agents_md__';

interface DocumentsSearch {
	file?: string;
}

function ProjectDocumentsPage() {
	const { teamId, projectId } = Route.useParams();
	const { file } = Route.useSearch();
	const navigate = Route.useNavigate();

	const { data: docs, isLoading: isLoadingList } = useProjectDocs(teamId, projectId);
	const { data: agentsMd } = useProjectAgentsMd(teamId, projectId);

	const updateDoc = useUpdateProjectDoc(teamId, projectId);
	const deleteDoc = useDeleteProjectDoc(teamId, projectId);
	const updateAgentsMd = useUpdateProjectAgentsMd(teamId, projectId);

	const [isCreating, setIsCreating] = useState(false);

	const isAgentsMd = file === AGENTS_MD_KEY;
	const filenameForFetch = file && !isAgentsMd ? file : null;
	const { data: doc, isLoading: isLoadingDoc } = useProjectDoc(teamId, projectId, filenameForFetch);

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
				meta: `Updated ${new Date(d.updated_at).toLocaleDateString()}`,
			});
		}
		return list;
	}, [agentsMd, docs]);

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
			teamId={teamId}
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
			getPopOutUrl={(key) =>
				key === AGENTS_MD_KEY ? null : docPreviewPath(teamId, projectId, key)
			}
			newForm={
				<NewProjectDocForm
					teamId={teamId}
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
					<ProjectDocRevisionsPanel teamId={teamId} projectId={projectId} filename={file} />
				) : null
			}
			emptyTitle="Select a document"
			emptyDescription="Choose a project document from the list to view or edit it."
		/>
	);
}

function ProjectDocRevisionsPanel({
	teamId,
	projectId,
	filename,
}: {
	teamId: string;
	projectId: string;
	filename: string;
}) {
	const { data: revisions } = useProjectDocRevisions(teamId, projectId, filename);
	const restore = useRestoreProjectDocRevision(teamId, projectId, filename);
	return (
		<RevisionsPanel
			revisions={revisions}
			onRestore={(rev) => restore.mutateAsync(rev)}
			isRestoring={restore.isPending}
		/>
	);
}

function NewProjectDocForm({
	teamId,
	projectSlug,
	onCancel,
	onCreate,
	isPending,
}: {
	teamId: string;
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
				teamId={teamId}
				projectSlug={projectSlug}
				label="Content (Markdown)"
				value={content}
				onChange={(e) => setContent(e.target.value)}
				className="min-h-[300px] font-mono text-xs"
			/>
			{error && <p className="text-sm text-accent-red">{error}</p>}
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

export const Route = createFileRoute('/teams/$teamId/projects/$projectId/documents')({
	validateSearch: (search: Record<string, unknown>): DocumentsSearch => ({
		file: typeof search.file === 'string' ? search.file : undefined,
	}),
	beforeLoad: ({ params }) => {
		if (params.projectId === INTERNAL_PROJECT_SLUG) {
			throw redirect({
				to: '/teams/$teamId/projects/$projectId/tasks',
				params,
				replace: true,
			});
		}
	},
	component: ProjectDocumentsPage,
});

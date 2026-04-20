import { createFileRoute } from '@tanstack/react-router';
import { Clock, Loader2, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type DocItem, DocsLibrary } from '../../../../components/docs-library';
import { Button } from '../../../../components/ui/button';
import { Card } from '../../../../components/ui/card';
import { Input } from '../../../../components/ui/input';
import { Textarea } from '../../../../components/ui/textarea';
import {
	useCreateKbDoc,
	useDeleteKbDoc,
	useKbDoc,
	useKbDocRevisions,
	useKbDocs,
	useRestoreKbDocRevision,
	useUpdateKbDoc,
} from '../../../../hooks/use-kb-docs';

interface KbSearch {
	slug?: string;
}

function KbPage() {
	const { companyId } = Route.useParams();
	const { slug } = Route.useSearch();
	const navigate = Route.useNavigate();

	const { data: docs, isLoading: isLoadingList } = useKbDocs(companyId);
	const selectedSlug = slug ?? null;

	const { data: doc, isLoading: isLoadingDoc } = useKbDoc(companyId, selectedSlug ?? '');
	const updateDoc = useUpdateKbDoc(companyId, selectedSlug ?? '');
	const deleteDoc = useDeleteKbDoc(companyId);
	const createDoc = useCreateKbDoc(companyId);

	const [isCreating, setIsCreating] = useState(false);

	const items = useMemo<DocItem[]>(
		() =>
			(docs ?? []).map((d) => ({
				key: d.slug,
				label: d.title,
				meta: `${d.last_updated_by_name ? `${d.last_updated_by_name} · ` : ''}${new Date(
					d.updated_at,
				).toLocaleDateString()}`,
			})),
		[docs],
	);

	function selectSlug(key: string | null) {
		navigate({
			search: (prev) => ({ ...(prev as KbSearch), slug: key ?? undefined }),
			replace: true,
		});
		setIsCreating(false);
	}

	async function handleSave(content: string) {
		if (!selectedSlug) return;
		await updateDoc.mutateAsync({ content });
	}

	async function handleDelete() {
		if (!selectedSlug) return;
		await deleteDoc.mutateAsync(selectedSlug);
	}

	return (
		<DocsLibrary
			items={items}
			isLoadingList={isLoadingList}
			selectedKey={selectedSlug}
			onSelect={selectSlug}
			docContent={selectedSlug ? (doc?.content ?? null) : null}
			isLoadingDoc={isLoadingDoc}
			onSave={handleSave}
			isSaving={updateDoc.isPending}
			onDelete={handleDelete}
			onNewDoc={() => {
				setIsCreating(true);
				navigate({
					search: (prev) => ({ ...(prev as KbSearch), slug: undefined }),
					replace: true,
				});
			}}
			isCreating={isCreating}
			newForm={
				<NewKbDocForm
					onCancel={() => setIsCreating(false)}
					onCreate={async (title, content) => {
						const created = await createDoc.mutateAsync({ title, content });
						setIsCreating(false);
						navigate({
							search: (prev) => ({ ...(prev as KbSearch), slug: created.slug }),
							replace: true,
						});
					}}
					isPending={createDoc.isPending}
				/>
			}
			viewerExtras={selectedSlug && <KbRevisionsPanel companyId={companyId} slug={selectedSlug} />}
			emptyTitle="Knowledge base"
			emptyDescription="Choose a document to view or edit, or create a new one."
		/>
	);
}

function NewKbDocForm({
	onCancel,
	onCreate,
	isPending,
}: {
	onCancel: () => void;
	onCreate: (title: string, content: string) => Promise<void>;
	isPending: boolean;
}) {
	const [title, setTitle] = useState('');
	const [content, setContent] = useState('');

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		await onCreate(title.trim(), content);
	}

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-2xl">
			<h2 className="text-base font-semibold">New document</h2>
			<Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
			<Textarea
				label="Content (Markdown)"
				value={content}
				onChange={(e) => setContent(e.target.value)}
				className="min-h-[300px] font-mono text-xs"
			/>
			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" disabled={!title.trim() || isPending}>
					{isPending && <Loader2 className="w-4 h-4 animate-spin" />}
					Create
				</Button>
			</div>
		</form>
	);
}

function KbRevisionsPanel({ companyId, slug }: { companyId: string; slug: string }) {
	const [open, setOpen] = useState(false);
	const { data: revisions } = useKbDocRevisions(companyId, slug);
	const restore = useRestoreKbDocRevision(companyId, slug);

	return (
		<div className="mt-6 pt-4 border-t border-border-subtle">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted hover:text-text mb-3"
			>
				<Clock className="w-3.5 h-3.5" />
				{open ? 'Hide' : 'Show'} revision history
				{revisions?.length ? ` (${revisions.length})` : ''}
			</button>

			{open && (
				<div className="space-y-2">
					{!revisions?.length ? (
						<p className="text-xs text-text-muted">No revisions yet.</p>
					) : (
						revisions.map((rev) => (
							<Card key={rev.id} className="p-3">
								<div className="flex items-center gap-2 mb-1">
									<span className="text-xs font-medium text-text">Rev {rev.revision_number}</span>
									<span className="text-xs text-text-muted">{rev.author_name || 'Board'}</span>
									<span className="text-xs text-text-subtle ml-auto">
										{new Date(rev.created_at).toLocaleString()}
									</span>
									<Button
										variant="ghost"
										size="sm"
										className="ml-1 text-xs"
										onClick={async () => {
											if (confirm(`Restore to revision ${rev.revision_number}?`)) {
												await restore.mutateAsync(rev.revision_number);
											}
										}}
									>
										<RotateCcw className="w-3 h-3" /> Restore
									</Button>
								</div>
								{rev.change_summary && (
									<p className="text-xs text-text-muted">{rev.change_summary}</p>
								)}
							</Card>
						))
					)}
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/kb/')({
	validateSearch: (search: Record<string, unknown>): KbSearch => ({
		slug: typeof search.slug === 'string' ? search.slug : undefined,
	}),
	component: KbPage,
});

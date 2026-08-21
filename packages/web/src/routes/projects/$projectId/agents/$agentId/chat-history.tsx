import { createFileRoute } from '@tanstack/react-router';
import { History, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { RevisionHistoryDialog } from '../../../../../components/document-review/revision-history-dialog';
import { ViewingRevisionBanner } from '../../../../../components/document-review/viewing-revision-banner';
import { MarkdownEditor } from '../../../../../components/markdown-editor';
import { MarkdownProse } from '../../../../../components/markdown-prose';
import { Button } from '../../../../../components/ui/button';
import { HelpDialog } from '../../../../../components/ui/help-dialog';
import { RelativeTime } from '../../../../../components/ui/relative-time';
import {
	useAgentChatMemory,
	useAgentChatMemoryRevisions,
	useRestoreAgentChatMemory,
	useUpdateAgentChatMemory,
} from '../../../../../hooks/use-agent-chat-memory';
import type { ApiError } from '../../../../../lib/api';
import {
	buildDocVersionHistory,
	type DocVersionEntry,
} from '../../../../../lib/doc-version-history';

function ChatHistoryHelp() {
	return (
		<HelpDialog title="How chat history works" triggerLabel="How chat history works">
			<div className="flex flex-col gap-3 text-sm text-text-2 leading-relaxed">
				<p>
					The chatbox keeps the most recent messages verbatim, up to a size cap. When the
					conversation grows past that cap, the assistant summarizes the whole window into this{' '}
					<strong className="text-text-1">long-term memory</strong> and the older messages drop out
					of the live chat - so scrolling up tops out at what's still in the window.
				</p>
				<p>
					This long-term memory is fed back into the assistant on every turn, so the gist of past
					exchanges survives even after the raw messages scroll away. It captures durable, standing
					knowledge only - operator preferences, decisions, and the gist of off-project threads -
					not live project or task state, which the assistant always reads fresh.
				</p>
				<p>
					It's maintained automatically; you don't need to ask the assistant to remember anything.
					You can edit it here to curate or correct what was captured.
				</p>
			</div>
		</HelpDialog>
	);
}

function ChatHistoryPage() {
	const { projectId, agentId } = Route.useParams();
	const { data, isLoading, error } = useAgentChatMemory(projectId, agentId);
	const updateMemory = useUpdateAgentChatMemory(projectId, agentId);
	const { data: revisions } = useAgentChatMemoryRevisions(projectId, agentId);
	const restoreMemory = useRestoreAgentChatMemory(projectId, agentId);

	const [value, setValue] = useState('');
	const [saveError, setSaveError] = useState<string | null>(null);
	const [historyOpen, setHistoryOpen] = useState(false);
	// The whole entry, not just its number — the body is rendered from it.
	const [viewingRevision, setViewingRevision] = useState<DocVersionEntry | null>(null);
	const serverContent = data?.content ?? '';

	const versionEntries = useMemo(
		() =>
			data
				? buildDocVersionHistory(
						{ content: data.content, updated_at: data.updated_at ?? '' },
						revisions,
					)
				: [],
		[data, revisions],
	);

	// Seed the editor from the server once loaded; re-sync when the stored value
	// changes underneath us (e.g. an automatic compaction) and the field is clean.
	useEffect(() => {
		setValue(serverContent);
	}, [serverContent]);

	if (isLoading) return <div className="text-text-2">Loading chat history…</div>;
	if (error) {
		return (
			<div className="text-text-2" data-testid="chat-history-unavailable">
				This agent has no chat history.
			</div>
		);
	}

	const dirty = value !== serverContent;

	async function handleSave() {
		setSaveError(null);
		try {
			await updateMemory.mutateAsync(value);
		} catch (e) {
			setSaveError((e as ApiError).message);
		}
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-1.5">
					<h2 className="text-[13px] font-medium">Long-term chat memory</h2>
					<ChatHistoryHelp />
				</div>
				<div className="flex items-center gap-2">
					{data?.updated_at && (
						<span className="text-[11px] text-text-3" data-testid="chat-history-updated">
							Updated <RelativeTime iso={data.updated_at} />
						</span>
					)}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => setHistoryOpen(true)}
						data-testid="chat-memory-history"
						aria-label="Revision history"
					>
						<History className="w-3.5 h-3.5" />
						<span className="hidden sm:inline">History</span>
					</Button>
				</div>
			</div>

			{viewingRevision && viewingRevision.revisionNumber !== null && (
				<ViewingRevisionBanner
					revisionNumber={viewingRevision.revisionNumber}
					timestamp={viewingRevision.timestamp}
					authorName={viewingRevision.authorName}
					onViewLatest={() => setViewingRevision(null)}
				/>
			)}

			{viewingRevision ? (
				/*
				 * Read-only, and never loaded into `value`: `dirty` drives Save, so
				 * seeding a past version here would arm Save to write it back.
				 */
				<div
					className="min-h-[240px] rounded-md border border-border bg-surface-2 px-4 py-3"
					data-testid="chat-memory-revision-body"
				>
					<MarkdownProse projectId={projectId} projectSlug={projectId}>
						{viewingRevision.content || '_(this version was empty)_'}
					</MarkdownProse>
				</div>
			) : (
				<MarkdownEditor
					value={value}
					onChange={setValue}
					ariaLabel="Long-term chat memory"
					projectId={projectId}
					projectSlug={projectId}
					rows={18}
					emptyPreviewText="_Nothing recorded yet. As the conversation grows, the assistant will compact older messages into memory here._"
					placeholder="The assistant maintains this automatically as the conversation is compacted."
				/>
			)}

			<div className="flex items-center gap-2">
				<Button
					size="sm"
					data-testid="chat-history-save"
					onClick={handleSave}
					disabled={!dirty || updateMemory.isPending || viewingRevision !== null}
				>
					{updateMemory.isPending && <Loader2 className="w-3 h-3 animate-spin" />} Save
				</Button>
				{saveError && (
					<span className="text-[13px] text-danger" data-testid="chat-history-error">
						{saveError}
					</span>
				)}
			</div>

			<RevisionHistoryDialog
				open={historyOpen}
				onOpenChange={setHistoryOpen}
				label="Long-term chat memory"
				entries={versionEntries}
				projectId={projectId}
				projectSlug={projectId}
				viewingRevision={viewingRevision?.revisionNumber ?? null}
				onView={(entry) => {
					setViewingRevision(entry.isCurrent ? null : entry);
					setHistoryOpen(false);
				}}
				onRestore={async (rev) => {
					await restoreMemory.mutateAsync(rev);
					setViewingRevision(null);
				}}
				isRestoring={restoreMemory.isPending}
			/>
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/agents/$agentId/chat-history')({
	component: ChatHistoryPage,
});

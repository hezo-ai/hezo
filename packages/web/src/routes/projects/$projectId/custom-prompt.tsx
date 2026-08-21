import { createFileRoute } from '@tanstack/react-router';
import { FileText, History, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { RevisionHistoryDialog } from '../../../components/document-review/revision-history-dialog';
import { ViewingRevisionBanner } from '../../../components/document-review/viewing-revision-banner';
import {
	InjectedTextCapNotice,
	injectedTextCapBlocks,
} from '../../../components/injected-text-cap-notice';
import { MarkdownEditor } from '../../../components/markdown-editor';
import { MarkdownProse } from '../../../components/markdown-prose';
import { Button } from '../../../components/ui/button';
import {
	useCustomPrompt,
	useCustomPromptRevisions,
	useRestoreCustomPromptRevision,
	useUpdateCustomPrompt,
} from '../../../hooks/use-custom-prompt';
import { buildDocVersionHistory, type DocVersionEntry } from '../../../lib/doc-version-history';

export const Route = createFileRoute('/projects/$projectId/custom-prompt')({
	component: CustomPromptPage,
});

function CustomPromptPage() {
	const { projectId } = Route.useParams();
	const { data: prefs } = useCustomPrompt(projectId);
	const { data: revisions } = useCustomPromptRevisions(projectId);
	const updatePrefs = useUpdateCustomPrompt(projectId);
	const restorePrefs = useRestoreCustomPromptRevision(projectId);

	const [content, setContent] = useState('');
	const [mode, setMode] = useState<'edit' | 'preview'>('edit');
	const [historyOpen, setHistoryOpen] = useState(false);
	// The whole entry, not just its number — the body is rendered from it.
	const [viewingRevision, setViewingRevision] = useState<DocVersionEntry | null>(null);

	// Seed (and re-sync) the editor from the saved value. `saved` only changes when
	// the stored content actually changes — initial load, a restore, or an update
	// from another actor — so this does not clobber in-progress typing on refetch.
	const saved = prefs?.content ?? '';
	useEffect(() => {
		setContent(saved);
	}, [saved]);

	const dirty = content !== saved;

	const versionEntries = useMemo(
		() => (prefs ? buildDocVersionHistory(prefs, revisions) : []),
		[prefs, revisions],
	);

	// Viewing a past version renders it read-only rather than loading it into the
	// editor: `content` drives `dirty`, so seeding it would arm Save to overwrite
	// the current prompt with the old body.
	const viewing = viewingRevision !== null;

	return (
		<div className="space-y-6 max-w-4xl">
			<header>
				<div className="flex items-start gap-3">
					<div className="min-w-0 flex-1">
						<h1 className="text-xl font-semibold flex items-center gap-2">
							<FileText className="size-5" />
							Custom Prompt
						</h1>
						<p className="text-sm text-text-3 mt-1">
							Shared instructions added to every agent's system prompt in this project - house
							conventions, standards, and standing do's and don'ts. Injected in full on every run,
							so keep it concise. Every edit is versioned and restorable.
						</p>
					</div>
					<Button
						variant="ghost"
						size="sm"
						className="shrink-0"
						onClick={() => setHistoryOpen(true)}
						data-testid="custom-prompt-history"
						aria-label="Revision history"
					>
						<History className="w-3.5 h-3.5" />
						<span className="hidden sm:inline">History</span>
					</Button>
				</div>
			</header>

			<div className="flex flex-col gap-3">
				{viewingRevision && viewingRevision.revisionNumber !== null && (
					<ViewingRevisionBanner
						revisionNumber={viewingRevision.revisionNumber}
						timestamp={viewingRevision.timestamp}
						authorName={viewingRevision.authorName}
						onViewLatest={() => setViewingRevision(null)}
					/>
				)}

				{viewing ? (
					<div
						className="min-h-[240px] rounded-md border border-border bg-surface-2 px-4 py-3"
						data-testid="custom-prompt-revision-body"
					>
						<MarkdownProse projectId={projectId} projectSlug={projectId}>
							{viewingRevision?.content || '_(this version was empty)_'}
						</MarkdownProse>
					</div>
				) : (
					<>
						<MarkdownEditor
							ariaLabel="Custom Prompt"
							value={content}
							onChange={setContent}
							defaultMode={mode}
							onModeChange={setMode}
							placeholder="e.g. Always write commit messages in the imperative mood. Prefer clarity over cleverness."
							rows={14}
							className="min-h-[240px] font-mono text-xs"
							previewClassName="min-h-[240px]"
							previewTestId="custom-prompt-preview"
							emptyPreviewText="_(nothing to preview)_"
						/>
						<InjectedTextCapNotice
							kind="team_preferences"
							content={content}
							savedLength={saved.length}
						/>
						<div className="flex justify-end">
							<Button
								size="sm"
								onClick={() => updatePrefs.mutateAsync({ content })}
								disabled={
									!dirty ||
									updatePrefs.isPending ||
									injectedTextCapBlocks('team_preferences', content, saved.length)
								}
							>
								{updatePrefs.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
								Save changes
							</Button>
						</div>
					</>
				)}
			</div>

			<RevisionHistoryDialog
				open={historyOpen}
				onOpenChange={setHistoryOpen}
				label="Custom Prompt"
				entries={versionEntries}
				projectId={projectId}
				projectSlug={projectId}
				viewingRevision={viewingRevision?.revisionNumber ?? null}
				onView={(entry) => {
					setViewingRevision(entry.isCurrent ? null : entry);
					setHistoryOpen(false);
				}}
				onRestore={async (rev) => {
					await restorePrefs.mutateAsync(rev);
					setViewingRevision(null);
				}}
				isRestoring={restorePrefs.isPending}
			/>
		</div>
	);
}

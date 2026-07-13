import { createFileRoute } from '@tanstack/react-router';
import { FileText, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MarkdownEditor } from '../../../components/markdown-editor';
import { RevisionsPanel } from '../../../components/revisions-panel';
import { Button } from '../../../components/ui/button';
import {
	usePreferenceRevisions,
	usePreferences,
	useRestorePreferenceRevision,
	useUpdatePreferences,
} from '../../../hooks/use-preferences';

export const Route = createFileRoute('/projects/$projectId/custom-prompt')({
	component: CustomPromptPage,
});

function CustomPromptPage() {
	const { projectId } = Route.useParams();
	const { data: prefs } = usePreferences(projectId);
	const { data: revisions } = usePreferenceRevisions(projectId);
	const updatePrefs = useUpdatePreferences(projectId);
	const restorePrefs = useRestorePreferenceRevision(projectId);

	const [content, setContent] = useState('');
	const [mode, setMode] = useState<'edit' | 'preview'>('edit');

	// Seed (and re-sync) the editor from the saved value. `saved` only changes when
	// the stored content actually changes — initial load, a restore, or an update
	// from another actor — so this does not clobber in-progress typing on refetch.
	const saved = prefs?.content ?? '';
	useEffect(() => {
		setContent(saved);
	}, [saved]);

	const dirty = content !== saved;

	return (
		<div className="space-y-6 max-w-4xl">
			<header>
				<h1 className="text-xl font-semibold flex items-center gap-2">
					<FileText className="size-5" />
					Custom Prompt
				</h1>
				<p className="text-sm text-text-3 mt-1">
					Shared instructions added to every agent's system prompt in this project — house
					conventions, standards, and standing do's and don'ts. Injected in full on every run, so
					keep it concise. Every edit is versioned and restorable below.
				</p>
			</header>

			<div className="flex flex-col gap-3">
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
				<div className="flex justify-end">
					<Button
						size="sm"
						onClick={() => updatePrefs.mutateAsync({ content })}
						disabled={!dirty || updatePrefs.isPending}
					>
						{updatePrefs.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
						Save changes
					</Button>
				</div>
			</div>

			<RevisionsPanel
				revisions={revisions}
				onRestore={(rev) => restorePrefs.mutateAsync(rev)}
				isRestoring={restorePrefs.isPending}
			/>
		</div>
	);
}

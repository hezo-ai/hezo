import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
	usePreferenceRevisions,
	usePreferences,
	useRestorePreferenceRevision,
	useUpdatePreferences,
} from '../../hooks/use-preferences';
import { RevisionsPanel } from '../revisions-panel';
import { Button } from '../ui/button';
import { SectionHeader } from './helpers';

export function PreferencesSection({ projectId }: { projectId: string }) {
	const { data: prefs } = usePreferences(projectId);
	const { data: revisions } = usePreferenceRevisions(projectId);
	const updatePrefs = useUpdatePreferences(projectId);
	const restorePrefs = useRestorePreferenceRevision(projectId);
	const [content, setContent] = useState('');
	const [editing, setEditing] = useState(false);

	useEffect(() => {
		if (prefs?.content) setContent(prefs.content);
	}, [prefs]);

	async function handleSave() {
		await updatePrefs.mutateAsync({ content });
		setEditing(false);
	}

	return (
		<section>
			<div className="flex items-center justify-between mb-4">
				<SectionHeader title="Preferences" desc="Custom instructions for all agents." />
				{!editing && (
					<Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
						Edit
					</Button>
				)}
			</div>
			{editing ? (
				<div className="flex flex-col gap-2">
					<textarea
						value={content}
						onChange={(e) => setContent(e.target.value)}
						className="w-full rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none focus:border-border-hover min-h-[120px] resize-y font-mono leading-relaxed"
					/>
					<div className="flex justify-end gap-2">
						<Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
							Cancel
						</Button>
						<Button size="sm" onClick={handleSave} disabled={updatePrefs.isPending}>
							{updatePrefs.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
							Save
						</Button>
					</div>
				</div>
			) : (
				<>
					<p className="text-[13px] text-text-muted whitespace-pre-wrap">
						{prefs?.content || 'No preferences set.'}
					</p>
					{prefs && (
						<RevisionsPanel
							revisions={revisions}
							onRestore={(rev) => restorePrefs.mutateAsync(rev)}
							isRestoring={restorePrefs.isPending}
						/>
					)}
				</>
			)}
		</section>
	);
}

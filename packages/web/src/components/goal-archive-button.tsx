import type { GoalWithProject } from '@hezo/shared';
import { Archive, ArchiveRestore } from 'lucide-react';
import { useState } from 'react';
import { useUpdateGoal } from '../hooks/use-goals';
import { useI18n } from '../lib/i18n';
import { ConfirmDialog } from './ui/confirm-dialog';

/**
 * Archive / unarchive toggle for one goal, shared by the Goals list card and the goal
 * detail header - the two surfaces that expose the control.
 *
 * Archiving is confirmed first. It is not a field edit: the goal leaves the active view
 * and the Captain stops checking it entirely, and the button sits one icon away from the
 * pencil, so a misclick silently retires an objective the team is still working toward.
 * Unarchiving is that action's undo and stays a single click.
 */
export function GoalArchiveButton({
	projectId,
	goal,
}: {
	projectId: string;
	goal: Pick<GoalWithProject, 'id' | 'title' | 'archived_at'>;
}) {
	const { t } = useI18n();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const updateGoal = useUpdateGoal(projectId, goal.id);
	const isArchived = !!goal.archived_at;
	const label = isArchived ? t('goals.unarchive.action') : t('goals.archive.action');

	return (
		<>
			<button
				type="button"
				onClick={() => (isArchived ? updateGoal.mutate({ archived: false }) : setConfirmOpen(true))}
				disabled={updateGoal.isPending}
				aria-label={label}
				title={label}
				data-testid="goal-archive"
				className="p-1 text-text-3 transition-colors hover:text-text-1 disabled:opacity-50"
			>
				{isArchived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
			</button>
			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title={t('goals.archive.confirmTitle')}
				// The goal's own title leads the body rather than being interpolated into the
				// sentence: the list renders one of these per card, so the dialog has to say
				// which goal it is, and a placeholder mid-sentence would not survive
				// translation into languages that order the clause differently.
				description={
					<>
						<span className="block font-medium text-text-1 break-words">{goal.title}</span>
						<span className="mt-1 block">{t('goals.archive.confirmDescription')}</span>
					</>
				}
				confirmLabel={t('goals.archive.confirmAction')}
				loading={updateGoal.isPending}
				onConfirm={async () => {
					await updateGoal.mutateAsync({ archived: true });
				}}
			/>
		</>
	);
}

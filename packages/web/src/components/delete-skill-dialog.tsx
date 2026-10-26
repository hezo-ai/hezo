import { useI18n } from '../lib/i18n';
import { ConfirmDialog } from './ui/confirm-dialog';

interface DeleteSkillDialogProps {
	/** The skill a row asked to delete; the dialog is open while one is set. */
	skill: { id: string; name: string } | null;
	onClose: () => void;
	onDelete: (id: string) => Promise<unknown>;
	deleting: boolean;
}

/** The confirmation a skill row asks for before it deletes, on the global and the project lists. */
export function DeleteSkillDialog({ skill, onClose, onDelete, deleting }: DeleteSkillDialogProps) {
	const { t } = useI18n();
	return (
		<ConfirmDialog
			open={skill !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={skill ? t('settings.skills.confirmDelete', { name: skill.name }) : ''}
			description={t('settings.skills.confirmDeleteBody')}
			confirmLabel={t('common.delete')}
			variant="danger"
			loading={deleting}
			onConfirm={async () => {
				if (skill) await onDelete(skill.id);
			}}
		/>
	);
}

import { useState } from 'react';
import { useI18n } from '../../lib/i18n';
import { MarkdownEditor } from '../markdown-editor';
import { Button } from '../ui/button';

interface MarkdownFieldEditorProps {
	/** Current stored value; seeds the draft when the editor mounts. */
	value: string | null | undefined;
	ariaLabel: string;
	projectId: string;
	projectSlug: string;
	placeholder?: string;
	className?: string;
	previewClassName?: string;
	/**
	 * Called with the draft when Save is pressed, `null` for an emptied field.
	 * Saving an unchanged draft is skipped here, so a save-without-edit never
	 * costs a request or a no-op row write.
	 */
	onSave: (next: string | null) => void;
	/** Leave edit mode. Called on Cancel and after a Save. */
	onClose: () => void;
}

/**
 * The edit body shared by every markdown field on the task page - the task
 * description card and the progress-summary / rules cards. It owns the draft and
 * the Cancel/Save row and nothing else, so each caller keeps its own very
 * different card chrome.
 */
export function MarkdownFieldEditor({
	value,
	ariaLabel,
	projectId,
	projectSlug,
	placeholder,
	className = 'min-h-[60px]',
	previewClassName = 'min-h-[60px]',
	onSave,
	onClose,
}: MarkdownFieldEditorProps) {
	const { t } = useI18n();
	const [draft, setDraft] = useState(value ?? '');

	return (
		<div className="flex flex-col gap-2">
			<MarkdownEditor
				ariaLabel={ariaLabel}
				projectId={projectId}
				projectSlug={projectSlug}
				value={draft}
				onChange={setDraft}
				placeholder={placeholder}
				className={className}
				previewClassName={previewClassName}
				emptyPreviewText="_(nothing to preview)_"
			/>
			<div className="flex gap-2 justify-end">
				<Button size="sm" variant="secondary" onClick={onClose}>
					{t('common.cancel')}
				</Button>
				<Button
					size="sm"
					onClick={() => {
						if (draft !== (value ?? '')) onSave(draft || null);
						onClose();
					}}
				>
					{t('common.save')}
				</Button>
			</div>
		</div>
	);
}

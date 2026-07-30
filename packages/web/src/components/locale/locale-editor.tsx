import type { LocaleSettings } from '@hezo/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { useSaveLocale } from '../../hooks/use-locale-settings';
import { useI18n } from '../../lib/i18n';
import { Button } from '../ui/button';
import { LocaleForm } from './locale-form';

/**
 * The locale picker plus its save behaviour - draft state, the save call, and
 * the error / saved-locally messages.
 *
 * Extracted because the same editor has three hosts: the onboarding language
 * step, the dialog behind the pre-auth globe button, and the Settings subpage.
 * Only the surrounding chrome differs, so only the chrome is written three
 * times.
 */
interface LocaleEditorProps {
	/** Label for the primary action ("Continue" during onboarding, "Save" after). */
	submitLabel: string;
	/** Rendered to the left of the submit button (e.g. a dialog Cancel). */
	secondaryAction?: ReactNode;
	/** Called after a save lands, so a dialog host can close itself. */
	onSaved?: () => void;
	/** Stack the actions full-width (onboarding) instead of right-aligning them. */
	fullWidthSubmit?: boolean;
	testId?: string;
}

export function LocaleEditor({
	submitLabel,
	secondaryAction,
	onSaved,
	fullWidthSubmit,
	testId,
}: LocaleEditorProps) {
	const i18n = useI18n();
	const { t } = i18n;
	const [draft, setDraft] = useState<LocaleSettings>({
		language: i18n.language,
		date_format: i18n.date_format,
		number_format: i18n.number_format,
	});
	const { save, scope, isPending, error } = useSaveLocale();

	// Re-seed whenever the active locale changes underneath us - another session
	// may have changed it, and a cancelled dialog must not leave a stale draft.
	useEffect(() => {
		setDraft({
			language: i18n.language,
			date_format: i18n.date_format,
			number_format: i18n.number_format,
		});
	}, [i18n.language, i18n.date_format, i18n.number_format]);

	async function handleSave() {
		try {
			await save(draft);
			onSaved?.();
		} catch {
			// A genuine failure keeps the editor open; `error` renders below.
		}
	}

	return (
		<div data-testid={testId}>
			<LocaleForm value={draft} onChange={setDraft} disabled={isPending} />

			{error && (
				<p className="mt-4 text-[13px] text-danger" role="alert">
					{t('locale.saveFailed')}
				</p>
			)}
			{scope === 'browser-only' && (
				<p className="mt-4 text-[13px] text-text-2" role="status">
					{t('locale.savedForBrowser')}
				</p>
			)}

			<div
				className={
					fullWidthSubmit ? 'mt-6' : 'mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end'
				}
			>
				{secondaryAction}
				<Button
					onClick={handleSave}
					disabled={isPending}
					className={fullWidthSubmit ? 'w-full' : undefined}
					data-testid="locale-save"
				>
					{isPending ? t('locale.saving') : submitLabel}
				</Button>
			</div>
		</div>
	);
}

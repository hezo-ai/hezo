import type { LocaleSettings } from '@hezo/shared';
import { useEffect, useState } from 'react';
import { type LocaleSaveScope, useSaveLocale } from '../../hooks/use-locale-settings';
import { LanguagePreview, type MessageKey, useI18n } from '../../lib/i18n';
import { Button } from '../ui/button';
import { LocaleForm } from './locale-form';

/**
 * The locale picker plus its save behaviour - draft state, the save call, and
 * the error / saved-locally messages.
 *
 * Extracted because the same editor has three hosts: the onboarding language
 * step, the dialog behind the pre-auth locale button, and the Settings subpage.
 * Only the surrounding chrome differs, so only the chrome is written three
 * times.
 *
 * The card renders inside a {@link LanguagePreview} keyed on the *draft*
 * language, so picking a language re-translates the picker itself immediately -
 * the operator sees the language they chose before committing to it. Nothing
 * outside the card moves, and nothing is written, until Continue/Save.
 */
interface LocaleEditorProps {
	/**
	 * Message key for the primary action ("Continue" during onboarding, "Save"
	 * after). A key rather than a rendered string - the hosts sit outside the
	 * preview, so a string they translated would be frozen in the old language.
	 */
	submitLabelKey: MessageKey;
	/** Render a Cancel beside the submit (the dialog host); called on click. */
	onCancel?: () => void;
	/** Called after a save lands, so a dialog host can close itself. */
	onSaved?: () => void;
	/** Stack the actions full-width (onboarding) instead of right-aligning them. */
	fullWidthSubmit?: boolean;
	testId?: string;
}

export function LocaleEditor({
	submitLabelKey,
	onCancel,
	onSaved,
	fullWidthSubmit,
	testId,
}: LocaleEditorProps) {
	const i18n = useI18n();
	const [draft, setDraft] = useState<LocaleSettings>({
		language: i18n.language,
		date_format: i18n.date_format,
		number_format: i18n.number_format,
	});
	const { save, scope, isPending, error } = useSaveLocale();

	// Re-seed whenever the active locale changes underneath us - another session
	// may have changed it, and a cancelled dialog must not leave a stale draft.
	// Keyed on the *committed* locale (this component sits outside its own
	// preview), so previewing a draft can never re-enter and clobber it.
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
			<LanguagePreview language={draft.language}>
				<LocaleEditorBody
					draft={draft}
					onChange={setDraft}
					onSave={handleSave}
					onCancel={onCancel}
					submitLabelKey={submitLabelKey}
					fullWidthSubmit={fullWidthSubmit}
					isPending={isPending}
					hasError={Boolean(error)}
					scope={scope}
				/>
			</LanguagePreview>
		</div>
	);
}

/**
 * Everything that renders *in the draft language*. Split out so its `t()` calls
 * resolve against the preview context rather than the committed one - a hook
 * cannot read a provider its own component renders.
 */
function LocaleEditorBody({
	draft,
	onChange,
	onSave,
	onCancel,
	submitLabelKey,
	fullWidthSubmit,
	isPending,
	hasError,
	scope,
}: {
	draft: LocaleSettings;
	onChange: (next: LocaleSettings) => void;
	onSave: () => void;
	onCancel?: () => void;
	submitLabelKey: MessageKey;
	fullWidthSubmit?: boolean;
	isPending: boolean;
	hasError: boolean;
	scope: LocaleSaveScope | null;
}) {
	const { t } = useI18n();

	return (
		<>
			<LocaleForm value={draft} onChange={onChange} disabled={isPending} />

			{hasError && (
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
				{onCancel && (
					<Button variant="secondary" onClick={onCancel}>
						{t('locale.settings.cancel')}
					</Button>
				)}
				<Button
					onClick={onSave}
					disabled={isPending}
					className={fullWidthSubmit ? 'w-full' : undefined}
					data-testid="locale-save"
				>
					{isPending ? t('locale.saving') : t(submitLabelKey)}
				</Button>
			</div>
		</>
	);
}

import { createFileRoute } from '@tanstack/react-router';
import { LocaleEditor } from '../../components/locale/locale-editor';
import { useI18n } from '../../lib/i18n';

/**
 * Settings -> Languages & formats. The signed-in home of the locale editor;
 * the globe button in the corner of the pre-auth gates is the same editor for
 * operators who have nowhere else to reach it yet.
 */
function LocaleSettingsPage() {
	const { t } = useI18n();
	return (
		<div className="max-w-[560px]">
			<h2 className="text-[15px] font-medium mb-1">{t('locale.settings.title')}</h2>
			<p className="text-[13px] text-text-2 mb-5">{t('locale.settings.pageDescription')}</p>
			<LocaleEditor submitLabel={t('locale.settings.save')} testId="locale-settings-page" />
		</div>
	);
}

export const Route = createFileRoute('/settings/locale')({
	component: LocaleSettingsPage,
});

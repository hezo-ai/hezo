import { useI18n } from '../../lib/i18n';
import { LocaleEditor } from '../locale/locale-editor';
import { OnboardingShell } from './onboarding-shell';

/**
 * The very first screen of a fresh instance, ahead of master-key generation.
 *
 * It runs before any credential exists, which is why it can persist at all: the
 * database is writable before the master key (the key encrypts the secrets
 * vault, not the database), and `PATCH /api/instance-settings/locale` is open
 * while no admin password is enrolled. So the choice is saved immediately and
 * survives a refresh mid-setup, rather than living in memory until some later
 * step flushes it.
 *
 * The form arrives pre-answered from `navigator.languages`, so an operator whose
 * browser is already German sees German selected and can simply continue.
 *
 * No locale button in the corner here - this screen *is* the locale picker.
 */
export function LanguageStep() {
	const { t } = useI18n();

	return (
		<OnboardingShell>
			<div className="text-center mb-6 sm:mb-10">
				<h1 className="text-xl sm:text-2xl font-semibold mb-2">{t('locale.title')}</h1>
				<p className="text-[13px] text-text-2">{t('locale.subtitle')}</p>
			</div>
			<div className="rounded-lg border border-border bg-surface p-5 sm:p-8 shadow-sm">
				<LocaleEditor
					submitLabel={t('locale.continue')}
					fullWidthSubmit
					testId="setup-step-language"
				/>
			</div>
		</OnboardingShell>
	);
}

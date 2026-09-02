import { THEME_OPTIONS, ThemeSwitcher as UiThemeSwitcher } from '@hezo/ui';
import { useI18n } from '../../lib/i18n';

export { THEME_OPTIONS } from '@hezo/ui';

/**
 * The theme menu, in this app's languages.
 *
 * **The choices carry an icon and a value, never a catalog key** — a key in the
 * package would put this app's translation layer inside it. The mapping from
 * `value` to a word lives here, and the Appearance settings page reads the same
 * option list and does the same lookup.
 */
export function ThemeSwitcher() {
	const { t } = useI18n();
	return (
		<UiThemeSwitcher
			label={t('theme.label')}
			optionLabels={{
				system: t('theme.system'),
				light: t('theme.light'),
				dark: t('theme.dark'),
			}}
		/>
	);
}

import { HelpDialog as UiHelpDialog } from '@hezo/ui';
import type { ComponentPropsWithoutRef } from 'react';
import { useI18n } from '../../lib/i18n';

/**
 * The shared help affordance, in this app's languages.
 *
 * **The primitive resolves no copy of its own**, so a component that opens a
 * dialog forwards the close button's name rather than letting the body fall
 * back to English. This wrapper is where the key is looked up, so every call
 * site keeps the import and the translation it already had.
 */
export function HelpDialog(
	props: Omit<ComponentPropsWithoutRef<typeof UiHelpDialog>, 'closeLabel'>,
) {
	const { t } = useI18n();
	return <UiHelpDialog closeLabel={t('common.close')} {...props} />;
}

import { DialogContent as UiDialogContent } from '@hezo/ui';
import type { ComponentPropsWithoutRef } from 'react';
import { useI18n } from '../../lib/i18n';

export {
	CONTENT_Z,
	type DialogSize,
	dialogContentClassName,
	dialogOverlayClassName,
	fullscreenContentClassName,
	OVERLAY_Z,
} from '@hezo/ui';

/**
 * The shared dialog body, in this app's languages.
 *
 * **The primitive resolves no copy of its own**, because a component that reads
 * the catalog cannot render outside an app that has one — which is what kept it
 * from being shared. It takes the close button's name as a prop, and this
 * wrapper is where the key is looked up, so every call site keeps the import
 * and the translation it already had.
 */
export function DialogContent(
	props: Omit<ComponentPropsWithoutRef<typeof UiDialogContent>, 'closeLabel'>,
) {
	const { t } = useI18n();
	return <UiDialogContent closeLabel={t('common.close')} {...props} />;
}

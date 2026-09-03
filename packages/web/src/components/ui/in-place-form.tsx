import { InPlaceForm as UiInPlaceForm } from '@hezo/ui';
import type { ComponentPropsWithoutRef } from 'react';
import { useI18n } from '../../lib/i18n';

type UiProps = ComponentPropsWithoutRef<typeof UiInPlaceForm>;

/**
 * The inline edit panel, in this app's languages.
 *
 * The primitive resolves no copy of its own, so this wrapper is where the key
 * is looked up.
 */
export function InPlaceForm({ closeLabel, ...props }: UiProps) {
	const { t } = useI18n();
	return <UiInPlaceForm closeLabel={closeLabel ?? t('common.close')} {...props} />;
}

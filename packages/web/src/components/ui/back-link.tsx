import { BackLink as UiBackLink } from '@hezo/ui';
import type { ComponentPropsWithoutRef } from 'react';
import { useI18n } from '../../lib/i18n';

type UiProps = ComponentPropsWithoutRef<typeof UiBackLink>;

/**
 * The "← Back" affordance, in this app's languages.
 *
 * The primitive resolves no copy of its own, so this wrapper is where the key
 * is looked up. Coalesced rather than spread over: a caller passing `label`
 * explicitly as `undefined` would otherwise fall through to the English
 * default instead of this app's translation.
 */
export function BackLink({ label, ...props }: UiProps) {
	const { t } = useI18n();
	return <UiBackLink label={label ?? t('common.back')} {...props} />;
}

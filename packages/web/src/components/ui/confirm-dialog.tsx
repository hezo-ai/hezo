import { type ConfirmDialogProps, ConfirmDialog as UiConfirmDialog } from '@hezo/ui';
import { useI18n } from '../../lib/i18n';

/**
 * The shared confirmation, in this app's languages.
 *
 * **The primitive resolves no copy of its own**, because a component that reads
 * the catalog cannot render outside an app that has one — which is what kept it
 * from being shared. It takes its labels as props, and this wrapper is where
 * the keys are looked up, so every call site keeps the import and the
 * translation it already had.
 *
 * `cancelLabel` and `errorLabel` are coalesced rather than spread over: a caller
 * passing either explicitly as `undefined` would otherwise fall through to the
 * primitive's English default instead of this app's translation.
 */
export function ConfirmDialog({
	cancelLabel,
	errorLabel,
	...props
}: Omit<ConfirmDialogProps, 'closeLabel'>) {
	const { t } = useI18n();
	return (
		<UiConfirmDialog
			closeLabel={t('common.close')}
			cancelLabel={cancelLabel ?? t('common.cancel')}
			errorLabel={errorLabel ?? (() => t('common.actionFailed'))}
			{...props}
		/>
	);
}

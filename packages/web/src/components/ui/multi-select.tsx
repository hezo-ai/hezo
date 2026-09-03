import { type MultiSelectProps, MultiSelect as UiMultiSelect } from '@hezo/ui';
import { useI18n } from '../../lib/i18n';

export type { MultiSelectOption } from '@hezo/ui';

/**
 * The multi-select, in this app's languages.
 *
 * The primitive takes each string as a prop with an English default; the lookups
 * live here, so the package needs no translation context to render.
 */
export function MultiSelect({ selectedLabel, emptyLabel, clearLabel, ...props }: MultiSelectProps) {
	const { t, plural } = useI18n();
	return (
		<UiMultiSelect
			selectedLabel={selectedLabel ?? ((count) => plural('common.selected', count))}
			emptyLabel={emptyLabel ?? t('common.noOptions')}
			clearLabel={clearLabel ?? t('common.clearSelection')}
			{...props}
		/>
	);
}

import {
	type ArchiveFilter,
	type AssetSortDirection,
	type AssetSortField,
	type AssetSortOrder,
	assetSortDirection,
	assetSortField,
} from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { useI18n } from '../lib/i18n';
import { DialogContent } from './ui/dialog';
import { FilterPills } from './ui/filter-pills';

/**
 * The assets library's filter and sort on a narrow viewport, where two
 * caption-plus-button pairs cannot share a row with the view toggle. The
 * toolbar keeps the toggle plus a trigger, and everything else lives here.
 *
 * Sort is offered as its two parts — the column, then the direction — rather
 * than as eight flat orders, which is both what fits a phone and what the
 * desktop column headers do. The pair resolves to the same `AssetSortOrder` the
 * URL carries.
 *
 * Picking a filter or a sort leaves the dialog open — they are usually set
 * together, and the list behind updates as each lands. Mirrors the inbox.
 */
export function AssetFilterDialog({
	open,
	onOpenChange,
	filterOptions,
	filter,
	onFilterChange,
	fieldOptions,
	directionOptions,
	sort,
	onSortChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	filterOptions: { value: ArchiveFilter; label: string; count: number }[];
	filter: ArchiveFilter;
	onFilterChange: (next: ArchiveFilter) => void;
	fieldOptions: { value: AssetSortField; label: string }[];
	/** Labelled for the selected column — "Smallest / Largest", "Oldest / Newest". */
	directionOptions: { value: AssetSortDirection; label: string }[];
	sort: AssetSortOrder;
	onSortChange: (field: AssetSortField, direction: AssetSortDirection) => void;
}) {
	const { t } = useI18n();
	const field = assetSortField(sort);
	const direction = assetSortDirection(sort);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm" aria-describedby={undefined} data-testid="asset-filter-dialog">
				<Dialog.Title className="text-[15px] font-medium pr-8">
					{t('assets.filters.title')}
				</Dialog.Title>

				<div className="mt-4 flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<span className="text-eyebrow">{t('assets.filters.showLabel')}</span>
						<FilterPills
							options={filterOptions}
							value={filter}
							onChange={onFilterChange}
							label={t('assets.filters.showLabel')}
							stretch
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<span className="text-eyebrow">{t('assets.filters.sortLabel')}</span>
						<FilterPills
							options={fieldOptions}
							value={field}
							onChange={(next) => onSortChange(next, direction)}
							label={t('assets.filters.sortLabel')}
							stretch
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<span className="text-eyebrow">{t('assets.filters.orderLabel')}</span>
						<FilterPills
							options={directionOptions}
							value={direction}
							onChange={(next) => onSortChange(field, next)}
							label={t('assets.filters.orderLabel')}
							tone="plain"
							stretch
						/>
					</div>
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}

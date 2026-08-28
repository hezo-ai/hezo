import * as Dialog from '@radix-ui/react-dialog';
import { CheckCheck } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import type { InboxSortOrder } from '../lib/inbox-sort';
import { DialogContent } from './ui/dialog';
import { FilterPills } from './ui/filter-pills';

interface InboxFilterDialogProps<TReadFilter extends string> {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	readOptions: { value: TReadFilter; label: string }[];
	readFilter: TReadFilter;
	onReadFilterChange: (next: TReadFilter) => void;
	sortOptions: { value: InboxSortOrder; label: string }[];
	sort: InboxSortOrder;
	onSortChange: (next: InboxSortOrder) => void;
	/** Omitted when the action does not apply to the current view. */
	onMarkAllRead?: () => void;
	markAllReadDisabled?: boolean;
}

/**
 * The inbox's filters on a narrow viewport, where the read filter, the sort and
 * "Mark all as read" cannot share a row with the search box. The toolbar keeps
 * search plus a trigger, and everything else lives here.
 *
 * Picking a filter or a sort leaves the dialog open — the two are usually set
 * together, and the list behind updates as each lands. Only the mark-all action
 * closes it, having completed.
 */
export function InboxFilterDialog<TReadFilter extends string>({
	open,
	onOpenChange,
	readOptions,
	readFilter,
	onReadFilterChange,
	sortOptions,
	sort,
	onSortChange,
	onMarkAllRead,
	markAllReadDisabled,
}: InboxFilterDialogProps<TReadFilter>) {
	const { t } = useI18n();
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm" data-testid="inbox-filter-dialog">
				<Dialog.Title className="text-[15px] font-medium pr-8">
					{t('inbox.filters.title')}
				</Dialog.Title>

				<div className="mt-4 flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<span className="text-eyebrow">{t('inbox.filters.showLabel')}</span>
						<FilterPills
							options={readOptions}
							value={readFilter}
							onChange={onReadFilterChange}
							label={t('inbox.filters.showLabel')}
							stretch
							className=""
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<span className="text-eyebrow">{t('inbox.filters.sortLabel')}</span>
						<FilterPills
							options={sortOptions}
							value={sort}
							onChange={onSortChange}
							label={t('inbox.filters.sortLabel')}
							tone="plain"
							stretch
							className=""
						/>
					</div>

					{onMarkAllRead && (
						<button
							type="button"
							onClick={() => {
								onMarkAllRead();
								onOpenChange(false);
							}}
							disabled={markAllReadDisabled}
							data-testid="inbox-mark-all-read"
							className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-[13px] text-text-2 transition-colors hover:bg-surface-2 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-2"
						>
							<CheckCheck className="w-3.5 h-3.5" />
							{t('inbox.markAllRead')}
						</button>
					)}
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}

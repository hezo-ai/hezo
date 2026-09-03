import { ChevronDown } from 'lucide-react';
import { SearchableSelect, type SearchableSelectOption } from './searchable-select.js';

export interface NameSwitcherButtonProps {
	options: SearchableSelectOption[];
	/** The currently-open item's value (checked in the list); null when none. */
	value: string | null;
	onSelect: (value: string) => void;
	/** Accessible label / tooltip for the trigger, e.g. "Switch document". */
	label: string;
	searchPlaceholder?: string;
	emptyLabel?: string;
	testId?: string;
}

/**
 * A dropdown button (chevron trigger) that opens a type-to-filter list for
 * jumping to another item by name — used as a suffix to a viewer's title to
 * switch the document/asset being viewed. Wraps {@link SearchableSelect} with a
 * native `<button>` trigger (the `ui/Button` doesn't forward a ref, so it can't
 * be a Radix `asChild` trigger). Options render in a portal — query them against
 * `document.body` in tests.
 */
export function NameSwitcherButton({
	options,
	value,
	onSelect,
	label,
	searchPlaceholder = 'Search…',
	emptyLabel = 'No matches',
	testId,
}: NameSwitcherButtonProps) {
	return (
		<SearchableSelect
			options={options}
			value={value}
			onChange={onSelect}
			searchPlaceholder={searchPlaceholder}
			emptyLabel={emptyLabel}
			testId={testId}
			align="start"
			trigger={
				<button
					type="button"
					aria-label={label}
					title={label}
					data-testid={testId ? `${testId}-button` : undefined}
					className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-text-2 outline-none transition-colors hover:bg-surface-3 hover:text-text-1 focus-visible:ring-[3px] focus-visible:ring-ring"
				>
					<ChevronDown className="h-3.5 w-3.5" />
				</button>
			}
		/>
	);
}

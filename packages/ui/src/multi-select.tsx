import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Loader2, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { touchMinHeightClassName } from './density.js';

export interface MultiSelectOption {
	value: string;
	label: string;
	/** A second, quieter line under the label. Searched as well when the select filters. */
	description?: string;
}

export interface MultiSelectProps {
	label: string;
	options: MultiSelectOption[];
	value: string[];
	onChange: (next: string[]) => void;
	/**
	 * Shown on the trigger while nothing is selected.
	 *
	 * **A prop with an English default, never a lookup.** An app with catalogs
	 * passes its own translation; one without gets English.
	 */
	placeholder?: string;
	/** Names the selection once more than one option is picked. */
	selectedLabel?: (count: number) => string;
	/** Shown in place of the list when there is nothing to pick. */
	emptyLabel?: string;
	/** The clear-all control's text. */
	clearLabel?: string;
	/**
	 * Draw a search box above the options.
	 *
	 * Without `onSearchChange` the select filters `options` itself, by label and
	 * description. With it, matching is the caller's: the select reports each
	 * term and draws `options` exactly as given, which is how a list too long to
	 * hand over whole is searched where it lives.
	 */
	searchable?: boolean;
	searchPlaceholder?: string;
	/**
	 * Called with the term on every change, and with an empty one when the list
	 * closes. The caller decides when to look it up; a request per keystroke is
	 * its own to pace.
	 */
	onSearchChange?: (term: string) => void;
	/** The options for the current term are still arriving. */
	loading?: boolean;
	loadingLabel?: string;
	/** Why the options could not be read, shown under them; nothing while it is null. */
	errorLabel?: string | null;
	/** A line under the options, such as that more matched than are shown. */
	hint?: string | null;
	/**
	 * Labels for chosen values `options` does not hold.
	 *
	 * A search that no longer returns a chosen value still has to name it, on the
	 * trigger and on its tag. A value with no label anywhere is shown as itself.
	 */
	selectedOptions?: MultiSelectOption[];
	/**
	 * How the selection is shown beside the trigger.
	 *
	 * `summary` names it on the trigger alone. `tags` also draws each chosen
	 * value as a tag that removes it, for a selection a reader needs to see
	 * whole.
	 */
	display?: 'summary' | 'tags';
	/** Names a tag's remove control, from the label of what it removes. */
	removeLabel?: (label: string) => string;
	className?: string;
	testId?: string;
}

/** Whether an option matches a typed term, by its label or its description. */
function matches(option: MultiSelectOption, term: string): boolean {
	const typed = term.trim().toLowerCase();
	if (!typed) return true;
	return (
		option.label.toLowerCase().includes(typed) ||
		(option.description ? option.description.toLowerCase().includes(typed) : false)
	);
}

export function MultiSelect({
	label,
	options,
	value,
	onChange,
	placeholder = 'Any',
	selectedLabel = (count) => `${count} selected`,
	emptyLabel = 'No options',
	clearLabel = 'Clear selection',
	searchable = false,
	searchPlaceholder = 'Search…',
	onSearchChange,
	loading = false,
	loadingLabel = 'Loading…',
	errorLabel = null,
	hint = null,
	selectedOptions = [],
	display = 'summary',
	removeLabel = (name) => `Remove ${name}`,
	className = '',
	testId,
}: MultiSelectProps) {
	const [term, setTerm] = useState('');
	const selectedSet = new Set(value);

	// What each value is called, from whatever names it: the current options
	// first, then the labels the caller keeps for values a search has dropped.
	const known = useMemo(() => {
		const names = new Map<string, string>();
		for (const option of selectedOptions) names.set(option.value, option.label);
		for (const option of options) names.set(option.value, option.label);
		return names;
	}, [options, selectedOptions]);
	// **The trigger names only what something names**, as it always has: a value
	// nothing labels is left off it. A tag still shows it, as itself, so a
	// selection can always be taken back.
	const selectedLabels = value.flatMap((v) => {
		const name = known.get(v);
		return name === undefined ? [] : [name];
	});

	const shown = searchable && !onSearchChange ? options.filter((o) => matches(o, term)) : options;

	function toggle(v: string) {
		if (selectedSet.has(v)) onChange(value.filter((x) => x !== v));
		else onChange([...value, v]);
	}

	function search(next: string) {
		setTerm(next);
		onSearchChange?.(next);
	}

	const triggerLabel =
		selectedLabels.length === 0
			? placeholder
			: selectedLabels.length === 1
				? selectedLabels[0]
				: selectedLabel(selectedLabels.length);

	const select = (
		<Popover.Root
			onOpenChange={(open) => {
				// A term left from the last visit would open the list already narrowed.
				if (!open && term) search('');
			}}
		>
			<Popover.Trigger asChild>
				{/* No `aria-label`: it would replace the visible text, and the current
				    selection is the half a reader most needs. The name comes from the
				    content, so it reads "Status: 2 selected" rather than "Status". */}
				<button
					type="button"
					data-testid={testId}
					className={`flex items-center justify-between gap-2 min-w-[140px] rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text-1 outline-none hover:border-border-strong cursor-pointer ${touchMinHeightClassName} ${className}`}
				>
					<span className="flex items-center gap-1.5 min-w-0">
						<span className="text-text-3">{label}:</span>
						<span className={`truncate ${selectedLabels.length === 0 ? 'text-text-2' : ''}`}>
							{triggerLabel}
						</span>
					</span>
					<ChevronDown className="w-3.5 h-3.5 text-text-3 shrink-0" aria-hidden />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={4}
					aria-label={label}
					data-testid={testId ? `${testId}-content` : undefined}
					className="z-50 min-w-[200px] max-w-[calc(100vw-2rem)] rounded-md border border-border bg-surface p-1 shadow-md"
				>
					{searchable && (
						<div className="flex items-center gap-1.5 border-b border-border px-2 pb-1.5 mb-1">
							<Search className="w-3.5 h-3.5 text-text-3 shrink-0" aria-hidden />
							<input
								// biome-ignore lint/a11y/noAutofocus: focusing the search box on open is the point
								autoFocus
								type="search"
								value={term}
								onChange={(e) => search(e.target.value)}
								placeholder={searchPlaceholder}
								aria-label={searchPlaceholder}
								data-testid={testId ? `${testId}-search` : undefined}
								className={`w-full bg-transparent text-[13px] text-text-1 outline-none placeholder:text-text-3 ${touchMinHeightClassName}`}
							/>
						</div>
					)}
					<div className="max-h-64 overflow-y-auto">
						{shown.length === 0 && !loading ? (
							<div role="status" className="px-3 py-2 text-[13px] text-text-2">
								{emptyLabel}
							</div>
						) : shown.length > 0 ? (
							<div role="menu" aria-label={label}>
								{shown.map((opt) => {
									const checked = selectedSet.has(opt.value);
									return (
										// The tick is decorative: `aria-checked` is what carries the state,
										// so a reader hears it rather than depending on a rendered glyph.
										<button
											key={opt.value}
											type="button"
											role="menuitemcheckbox"
											aria-checked={checked}
											onClick={() => toggle(opt.value)}
											// `items-start` seats a two-line row's box on its first line; under
											// touch the row is taller than its text, so a one-line row centres.
											className={`flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors cursor-pointer text-left in-data-[density=touch]:items-center ${touchMinHeightClassName} ${
												checked
													? 'text-text-1 bg-surface-2'
													: 'text-text-2 hover:text-text-1 hover:bg-surface-3'
											}`}
										>
											<span className="flex items-center justify-center w-4 h-4 mt-px rounded border border-border bg-surface shrink-0">
												{checked && <Check className="w-3 h-3 text-info" aria-hidden />}
											</span>
											<span className="min-w-0 flex-1">
												<span className="block truncate">{opt.label}</span>
												{opt.description && (
													<span className="block truncate text-[11px] text-text-3">
														{opt.description}
													</span>
												)}
											</span>
										</button>
									);
								})}
							</div>
						) : null}
						{loading && (
							<div
								role="status"
								className="flex items-center gap-2 px-2.5 py-2 text-[13px] text-text-2"
							>
								<Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-text-3" aria-hidden />
								{loadingLabel}
							</div>
						)}
					</div>
					{/* Outside the scroll box, so neither is scrolled away from the reader. */}
					{errorLabel && (
						<div className="mt-1 border-t border-border px-2.5 pt-1.5 pb-1 text-[13px] text-danger break-words">
							{errorLabel}
						</div>
					)}
					{hint && <div className="px-2.5 pt-1 pb-0.5 text-[11px] text-text-3">{hint}</div>}
					{value.length > 0 && (
						<div className="border-t border-border mt-1 pt-1">
							<button
								type="button"
								onClick={() => onChange([])}
								className={`w-full text-[11px] text-text-3 hover:text-text-1 py-1 cursor-pointer ${touchMinHeightClassName}`}
							>
								{clearLabel}
							</button>
						</div>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);

	if (display === 'summary' || value.length === 0) return select;

	return (
		<div className="flex flex-col items-start gap-1.5 min-w-0">
			{select}
			<ul aria-label={label} className="flex flex-wrap gap-1.5 min-w-0">
				{value.map((v) => {
					const name = known.get(v) ?? v;
					return (
						<li key={v} className="min-w-0">
							<button
								type="button"
								aria-label={removeLabel(name)}
								onClick={() => onChange(value.filter((x) => x !== v))}
								className={`inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-2 py-0.5 pl-2.5 pr-1.5 text-xs text-text-1 hover:bg-surface-3 cursor-pointer ${touchMinHeightClassName}`}
							>
								<span className="truncate">{name}</span>
								<X className="w-3 h-3 shrink-0 text-text-3" aria-hidden />
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

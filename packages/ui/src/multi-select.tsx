import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';

export interface MultiSelectOption {
	value: string;
	label: string;
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
	className?: string;
	testId?: string;
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
	className = '',
	testId,
}: MultiSelectProps) {
	const selectedSet = new Set(value);
	const selectedLabels = options.filter((o) => selectedSet.has(o.value)).map((o) => o.label);

	function toggle(v: string) {
		if (selectedSet.has(v)) onChange(value.filter((x) => x !== v));
		else onChange([...value, v]);
	}

	const triggerLabel =
		selectedLabels.length === 0
			? placeholder
			: selectedLabels.length === 1
				? selectedLabels[0]
				: selectedLabel(selectedLabels.length);

	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				{/* No `aria-label`: it would replace the visible text, and the current
				    selection is the half a reader most needs. The name comes from the
				    content, so it reads "Status: 2 selected" rather than "Status". */}
				<button
					type="button"
					data-testid={testId}
					className={`flex items-center justify-between gap-2 min-w-[140px] rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-text-1 outline-none hover:border-border-strong cursor-pointer ${className}`}
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
					className="z-50 min-w-[200px] max-h-64 overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-md"
				>
					{options.length === 0 ? (
						<div className="px-3 py-2 text-[13px] text-text-2">{emptyLabel}</div>
					) : (
						<div role="menu" aria-label={label}>
							{options.map((opt) => {
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
										className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors cursor-pointer text-left ${
											checked
												? 'text-text-1 bg-surface-2'
												: 'text-text-2 hover:text-text-1 hover:bg-surface-3'
										}`}
									>
										<span className="flex items-center justify-center w-4 h-4 rounded border border-border bg-surface shrink-0">
											{checked && <Check className="w-3 h-3 text-info" aria-hidden />}
										</span>
										<span className="flex-1 truncate">{opt.label}</span>
									</button>
								);
							})}
						</div>
					)}
					{value.length > 0 && (
						<div className="border-t border-border mt-1 pt-1">
							<button
								type="button"
								onClick={() => onChange([])}
								className="w-full text-[11px] text-text-3 hover:text-text-1 py-1 cursor-pointer"
							>
								{clearLabel}
							</button>
						</div>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

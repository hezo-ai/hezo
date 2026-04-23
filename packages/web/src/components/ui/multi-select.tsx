import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown } from 'lucide-react';

export interface MultiSelectOption {
	value: string;
	label: string;
}

interface MultiSelectProps {
	label: string;
	options: MultiSelectOption[];
	value: string[];
	onChange: (next: string[]) => void;
	placeholder?: string;
	className?: string;
	testId?: string;
}

export function MultiSelect({
	label,
	options,
	value,
	onChange,
	placeholder = 'Any',
	className = '',
	testId,
}: MultiSelectProps) {
	const selectedSet = new Set(value);
	const selectedLabels = options.filter((o) => selectedSet.has(o.value)).map((o) => o.label);

	function toggle(v: string) {
		if (selectedSet.has(v)) {
			onChange(value.filter((x) => x !== v));
		} else {
			onChange([...value, v]);
		}
	}

	const triggerLabel =
		selectedLabels.length === 0
			? placeholder
			: selectedLabels.length === 1
				? selectedLabels[0]
				: `${selectedLabels.length} selected`;

	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<button
					type="button"
					data-testid={testId}
					aria-label={label}
					className={`flex items-center justify-between gap-2 min-w-[140px] rounded-radius-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text outline-none hover:border-border-hover cursor-pointer ${className}`}
				>
					<span className="flex items-center gap-1.5 min-w-0">
						<span className="text-text-subtle">{label}:</span>
						<span className={`truncate ${selectedLabels.length === 0 ? 'text-text-muted' : ''}`}>
							{triggerLabel}
						</span>
					</span>
					<ChevronDown className="w-3.5 h-3.5 text-text-subtle shrink-0" />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={4}
					className="z-50 min-w-[200px] max-h-64 overflow-y-auto rounded-radius-md border border-border bg-bg-elevated p-1 shadow-md"
				>
					{options.length === 0 ? (
						<div className="px-3 py-2 text-[13px] text-text-muted">No options</div>
					) : (
						options.map((opt) => {
							const checked = selectedSet.has(opt.value);
							return (
								<button
									key={opt.value}
									type="button"
									onClick={() => toggle(opt.value)}
									className={`flex w-full items-center gap-2 rounded-radius-md px-2.5 py-1.5 text-[13px] transition-colors cursor-pointer text-left ${
										checked
											? 'text-text bg-bg-subtle'
											: 'text-text-muted hover:text-text hover:bg-bg-muted'
									}`}
								>
									<span className="flex items-center justify-center w-4 h-4 rounded border border-border bg-bg shrink-0">
										{checked && <Check className="w-3 h-3 text-accent-blue" />}
									</span>
									<span className="flex-1 truncate">{opt.label}</span>
								</button>
							);
						})
					)}
					{value.length > 0 && (
						<div className="border-t border-border mt-1 pt-1">
							<button
								type="button"
								onClick={() => onChange([])}
								className="w-full text-[11px] text-text-subtle hover:text-text py-1 cursor-pointer"
							>
								Clear selection
							</button>
						</div>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

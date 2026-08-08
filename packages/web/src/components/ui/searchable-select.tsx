import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Search } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

export interface SearchableSelectOption {
	value: string;
	label: string;
	/** Optional secondary line rendered under the label (also searchable). */
	description?: string;
}

interface SearchableSelectProps {
	options: SearchableSelectOption[];
	value: string | null;
	onChange: (value: string) => void;
	/**
	 * Custom trigger element (rendered via Radix `asChild`). Must be a single
	 * focusable element that forwards props/ref (e.g. a `<button>`). Falls back to
	 * a labelled button showing the current selection.
	 */
	trigger?: ReactNode;
	placeholder?: string;
	searchPlaceholder?: string;
	emptyLabel?: string;
	align?: 'start' | 'center' | 'end';
	className?: string;
	contentClassName?: string;
	testId?: string;
	disabled?: boolean;
	/**
	 * Whether to show the type-to-filter box. Default true.
	 *
	 * A search field over two or three fixed options is noise - it invites typing
	 * where the whole list is already on screen. Widening this component rather
	 * than hand-rolling a second dropdown keeps one implementation of the popover,
	 * the keyboard behaviour and the checked-state rendering.
	 */
	searchable?: boolean;
}

/**
 * A single-select dropdown with a type-to-filter search box. Reusable anywhere a
 * plain `<select>` gets unwieldy with many options. Renders in a Radix portal, so
 * query the option buttons against `document.body` in tests.
 */
export function SearchableSelect({
	options,
	value,
	onChange,
	trigger,
	placeholder = 'Select…',
	searchPlaceholder = 'Search…',
	emptyLabel = 'No matches',
	align = 'start',
	className = '',
	contentClassName = '',
	testId,
	disabled = false,
	searchable = true,
}: SearchableSelectProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');

	const selected = options.find((o) => o.value === value) ?? null;
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return options;
		return options.filter(
			(o) =>
				o.label.toLowerCase().includes(q) ||
				(o.description ? o.description.toLowerCase().includes(q) : false),
		);
	}, [options, query]);

	function handleSelect(next: string) {
		onChange(next);
		setOpen(false);
		setQuery('');
	}

	return (
		<Popover.Root
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setQuery('');
			}}
		>
			<Popover.Trigger asChild disabled={disabled}>
				{trigger ?? (
					<button
						type="button"
						data-testid={testId}
						className={`flex items-center justify-between gap-2 min-w-[160px] rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-text-1 outline-none hover:border-border-strong focus:border-border-strong disabled:opacity-50 cursor-pointer ${className}`}
					>
						<span className={`truncate ${selected ? '' : 'text-text-2'}`}>
							{selected ? selected.label : placeholder}
						</span>
						<ChevronDown className="w-3.5 h-3.5 text-text-3 shrink-0" />
					</button>
				)}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align={align}
					sideOffset={4}
					data-testid={testId ? `${testId}-content` : undefined}
					className={`z-50 min-w-[220px] rounded-md border border-border bg-surface p-1 shadow-md ${contentClassName}`}
				>
					{searchable && (
						<div className="flex items-center gap-1.5 border-b border-border px-2 pb-1.5 mb-1">
							<Search className="w-3.5 h-3.5 text-text-3 shrink-0" />
							<input
								// biome-ignore lint/a11y/noAutofocus: focusing the search box on open is the point
								autoFocus
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder={searchPlaceholder}
								aria-label={searchPlaceholder}
								data-testid={testId ? `${testId}-search` : undefined}
								className="w-full bg-transparent text-[13px] text-text-1 outline-none placeholder:text-text-3"
							/>
						</div>
					)}
					<div className="max-h-64 overflow-y-auto">
						{filtered.length === 0 ? (
							<div className="px-2.5 py-2 text-[13px] text-text-2">{emptyLabel}</div>
						) : (
							filtered.map((opt) => {
								const active = opt.value === value;
								return (
									<button
										key={opt.value}
										type="button"
										onClick={() => handleSelect(opt.value)}
										data-testid={testId ? `${testId}-option-${opt.value}` : undefined}
										className={`flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors cursor-pointer ${
											active
												? 'text-text-1 bg-surface-2'
												: 'text-text-2 hover:text-text-1 hover:bg-surface-3'
										}`}
									>
										<Check
											className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${active ? 'text-info' : 'text-transparent'}`}
										/>
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
							})
						)}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

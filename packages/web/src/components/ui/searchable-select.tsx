import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Loader2, Search } from 'lucide-react';
import { Fragment, type ReactNode, useMemo, useState } from 'react';

export interface SearchableSelectOption {
	value: string;
	label: string;
	/** Optional secondary line rendered under the label (also searchable). */
	description?: string;
	/**
	 * Draw a divider above this option, unless it is the first one shown. Groups a
	 * pinned head (a "no choice" fallback, a stored-but-absent value) off from the
	 * body of the list without a second options array — and collapses on its own
	 * once a filter makes the option the first row.
	 */
	separatorBefore?: boolean;
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
	/**
	 * Show a spinner row under the options while the caller is still fetching
	 * them. The options already known stay selectable, so a pinned head renders
	 * immediately rather than the panel opening empty.
	 */
	loading?: boolean;
	/** Text beside the loading spinner. Pass a translated string. */
	loadingLabel?: string;
	/**
	 * Render a failure inside the panel rather than beside the trigger. A message
	 * from an upstream service has no length ceiling, and next to the trigger it
	 * widens whatever lays the trigger out - a table column, a form row.
	 */
	errorLabel?: string | null;
	/**
	 * Notified when the panel opens or closes. Lets a caller fetch its options
	 * lazily on first open instead of on mount.
	 */
	onOpenChange?: (open: boolean) => void;
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
	loading = false,
	loadingLabel = 'Loading…',
	errorLabel = null,
	onOpenChange,
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
				onOpenChange?.(next);
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
						{filtered.length === 0 && !loading && (
							<div className="px-2.5 py-2 text-[13px] text-text-2">{emptyLabel}</div>
						)}
						{filtered.map((opt, i) => {
							const active = opt.value === value;
							return (
								<Fragment key={opt.value}>
									{/* A divider above the first row would read as a stray rule, so the
									    pinned head loses it once a filter promotes it to the top. */}
									{opt.separatorBefore && i > 0 && <div className="mx-1.5 my-1 h-px bg-border" />}
									<button
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
								</Fragment>
							);
						})}
						{loading && (
							<div className="flex items-center gap-2 px-2.5 py-2 text-[13px] text-text-2">
								<Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-text-3" />
								{loadingLabel}
							</div>
						)}
					</div>
					{/* Outside the scroll box: a failure stays on screen however far down the
					    options the reader has scrolled. */}
					{errorLabel && (
						<div
							data-testid={testId ? `${testId}-error` : undefined}
							className="mt-1 border-t border-border px-2.5 pt-1.5 pb-1 text-[13px] text-danger break-words"
						>
							{errorLabel}
						</div>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

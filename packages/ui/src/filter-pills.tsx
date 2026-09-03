import type { ReactNode } from 'react';

export interface FilterPillsProps<T extends string> {
	options: { value: T; label: string; count?: number; badge?: ReactNode }[];
	value: T;
	onChange: (value: T) => void;
	/** Fill the container width with equal segments (e.g. inside a narrow rail). */
	stretch?: boolean;
	/**
	 * Accessible name for the group. Worth setting wherever two tracks sit side by
	 * side - a filter and a sort read as one undifferentiated row of buttons
	 * without it.
	 */
	label?: string;
	/**
	 * Track background. `plain` sits on `surface` instead of `surface-2`, which is
	 * how a second group next to a first one reads as its sibling rather than as
	 * more of the same bar. Not a `className` override: two `bg-*` utilities on one
	 * element resolve by stylesheet order, not by the order they are written in.
	 */
	tone?: 'default' | 'plain';
	/** Appended to the track, like every other primitive's - not a replacement. */
	className?: string;
}

// Wire's `.hz-seg` segmented control: a surface-2 track with an inverse
// (near-black) active pill. Counts render in Geist Mono.
export function FilterPills<T extends string>({
	options,
	value,
	onChange,
	stretch,
	label,
	tone = 'default',
	className = '',
}: FilterPillsProps<T>) {
	return (
		// `min-w-0` is load-bearing: a fieldset defaults to
		// `min-inline-size: min-content`, which stops it shrinking inside a narrow
		// container - the same trap SegmentedControl documents.
		<fieldset
			aria-label={label}
			className={`${stretch ? 'flex' : 'inline-flex flex-wrap'} min-w-0 gap-0.5 rounded-md border border-border ${tone === 'plain' ? 'bg-surface' : 'bg-surface-2'} p-0.5 ${className}`}
		>
			{options.map((opt) => {
				const active = value === opt.value;
				return (
					<button
						key={opt.value}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(opt.value)}
						className={`inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
							stretch ? 'flex-1 justify-center px-1' : ''
						} ${active ? 'bg-inverse text-inverse-fg' : 'text-text-2 hover:text-text-1'}`}
					>
						{opt.label}
						{opt.count != null && (
							<span
								className={`font-mono text-[11px] ${active ? 'text-inverse-fg/70' : 'text-text-3'}`}
							>
								{opt.count}
							</span>
						)}
						{opt.badge}
					</button>
				);
			})}
		</fieldset>
	);
}

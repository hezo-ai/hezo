import type { ReactNode } from 'react';

interface FilterPillsProps<T extends string> {
	options: { value: T; label: string; count?: number; badge?: ReactNode }[];
	value: T;
	onChange: (value: T) => void;
}

// Wire's `.hz-seg` segmented control: a surface-2 track with an inverse
// (near-black) active pill. Counts render in Geist Mono.
export function FilterPills<T extends string>({ options, value, onChange }: FilterPillsProps<T>) {
	return (
		<div className="mb-3.5 inline-flex flex-wrap gap-0.5 rounded-md border border-border bg-surface-2 p-0.5">
			{options.map((opt) => {
				const active = value === opt.value;
				return (
					<button
						key={opt.value}
						type="button"
						onClick={() => onChange(opt.value)}
						className={`inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
							active ? 'bg-inverse text-inverse-fg' : 'text-text-2 hover:text-text-1'
						}`}
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
		</div>
	);
}

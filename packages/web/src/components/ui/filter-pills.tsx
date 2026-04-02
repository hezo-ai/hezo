interface FilterPillsProps<T extends string> {
	options: { value: T; label: string }[];
	value: T;
	onChange: (value: T) => void;
}

export function FilterPills<T extends string>({ options, value, onChange }: FilterPillsProps<T>) {
	return (
		<div className="flex gap-1.5 flex-wrap mb-3.5">
			{options.map((opt) => (
				<button
					key={opt.value}
					type="button"
					onClick={() => onChange(opt.value)}
					className={`text-xs px-3 py-1 rounded-radius-md cursor-pointer transition-colors ${
						value === opt.value
							? 'bg-primary text-bg'
							: 'bg-bg-subtle text-text-muted hover:text-text'
					}`}
				>
					{opt.label}
				</button>
			))}
		</div>
	);
}

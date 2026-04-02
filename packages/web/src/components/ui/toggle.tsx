interface ToggleProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
	className?: string;
}

export function Toggle({ checked, onChange, disabled = false, className = '' }: ToggleProps) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`relative inline-flex w-8 h-[18px] rounded-full transition-colors duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
				checked ? 'bg-accent-blue' : 'bg-border-hover'
			} ${className}`}
		>
			<span
				className={`absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform duration-200 ${
					checked ? 'translate-x-[14px]' : 'translate-x-0'
				}`}
			/>
		</button>
	);
}

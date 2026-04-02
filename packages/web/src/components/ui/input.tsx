import type { InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
	label?: string;
}

export function Input({ label, className = '', id, ...props }: InputProps) {
	const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');
	return (
		<div className="flex flex-col gap-1.5">
			{label && (
				<label
					htmlFor={inputId}
					className="text-xs font-medium uppercase tracking-wider text-text-muted"
				>
					{label}
				</label>
			)}
			<input
				id={inputId}
				className={`rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-text-subtle outline-none focus:border-border-hover ${className}`}
				{...props}
			/>
		</div>
	);
}

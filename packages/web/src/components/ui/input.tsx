import type { InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
	label?: string;
}

export function Input({ label, className = '', id, ...props }: InputProps) {
	const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');
	return (
		<div className="flex flex-col gap-1.5">
			{label && (
				<label htmlFor={inputId} className="text-sm text-text-muted">
					{label}
				</label>
			)}
			<input
				id={inputId}
				className={`rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text placeholder:text-text-subtle outline-none focus:border-primary ${className}`}
				{...props}
			/>
		</div>
	);
}

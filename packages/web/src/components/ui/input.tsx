import type { InputHTMLAttributes, ReactNode } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
	label?: string;
	/** Optional leading icon (e.g. a search glyph), rendered inside the field. */
	icon?: ReactNode;
}

// Wire's `.hz-input`: 32px tall, strong border, surface bg, accent focus ring.
export function Input({ label, icon, className = '', id, ...props }: InputProps) {
	const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');
	return (
		<div className={`flex flex-col gap-1.5 ${className}`}>
			{label && (
				<label htmlFor={inputId} className="text-eyebrow text-text-2">
					{label}
				</label>
			)}
			<div className="flex h-8 w-full items-center gap-2 rounded-md border border-border-strong bg-surface px-2.5 text-[13px] transition-colors focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring">
				{icon && <span className="shrink-0 text-text-3">{icon}</span>}
				<input
					id={inputId}
					className="min-w-0 flex-1 bg-transparent text-text-1 placeholder:text-text-3 outline-none"
					{...props}
				/>
			</div>
		</div>
	);
}

import { type InputHTMLAttributes, type ReactNode, useId } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
	label?: string;
	/** Optional leading icon (e.g. a search glyph), rendered inside the field. */
	icon?: ReactNode;
	/** Class override for the wrapper (e.g. `sm:w-96`, `flex-1`) rather than the field. */
	wrapperClassName?: string;
}

// Wire's `.hz-input`: 32px tall, strong border, surface bg, accent focus ring.
export function Input({
	label,
	icon,
	className = '',
	wrapperClassName = 'flex flex-col gap-1.5',
	id,
	...props
}: InputProps) {
	// A generated id, never one derived from the label: two fields labelled the
	// same emit the same id, and every `<label for>` then points at the first of
	// them. A label also changes with the language, and can hold characters no
	// selector can address.
	const generatedId = useId();
	const inputId = id ?? generatedId;
	return (
		<div className={wrapperClassName}>
			{label && (
				<label htmlFor={inputId} className="text-eyebrow text-text-2">
					{label}
				</label>
			)}
			<div className="flex h-8 w-full items-center gap-2 rounded-md border border-border-strong bg-surface px-2.5 text-[13px] transition-colors focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring">
				{icon && <span className="shrink-0 text-text-3">{icon}</span>}
				<input
					id={inputId}
					className={`min-w-0 flex-1 bg-transparent text-text-1 placeholder:text-text-3 outline-none ${className}`}
					{...props}
				/>
			</div>
		</div>
	);
}

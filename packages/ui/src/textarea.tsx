import { forwardRef, type TextareaHTMLAttributes, useId } from 'react';
import type { InputSize } from './input.js';

// The same three rows as `Input`, in the axes a growing field has: padding,
// type size and the floor it starts at. Every row already clears 44px, so
// there is no touch floor to add.
const textareaSizeClassName: Record<InputSize, string> = {
	sm: 'px-2.5 py-1.5 text-[12.5px] rounded-sm min-h-[56px]',
	md: 'px-3 py-2 text-[13px] rounded-md min-h-[72px]',
	lg: 'px-4 py-2.5 text-sm rounded-md min-h-[96px]',
};

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
	label?: string;
	/** Class override for the flex wrapper (e.g. `flex-1 min-h-0` so the textarea
	 *  can grow to fill a flex column). Defaults to the standard stacked layout. */
	wrapperClassName?: string;
	/** Density preset, mirroring `Input`'s. Defaults to `md`. */
	size?: InputSize;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
	{ label, size = 'md', className = '', wrapperClassName = 'flex flex-col gap-1.5', id, ...props },
	ref,
) {
	// A generated id, never one derived from the label - see `input.tsx`.
	const generatedId = useId();
	const inputId = id ?? generatedId;
	return (
		<div className={wrapperClassName}>
			{label && (
				<label htmlFor={inputId} className="text-eyebrow text-text-2">
					{label}
				</label>
			)}
			<textarea
				ref={ref}
				id={inputId}
				className={`border border-border-strong bg-surface text-text-1 placeholder:text-text-3 outline-none transition-colors focus:border-accent focus:ring-[3px] focus:ring-ring resize-y leading-relaxed ${textareaSizeClassName[size]} ${className}`}
				{...props}
			/>
		</div>
	);
});

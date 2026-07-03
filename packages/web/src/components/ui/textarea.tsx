import { forwardRef, type TextareaHTMLAttributes } from 'react';

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
	label?: string;
	/** Class override for the flex wrapper (e.g. `flex-1 min-h-0` so the textarea
	 *  can grow to fill a flex column). Defaults to the standard stacked layout. */
	wrapperClassName?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
	{ label, className = '', wrapperClassName = 'flex flex-col gap-1.5', id, ...props },
	ref,
) {
	const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');
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
				className={`rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-text-1 placeholder:text-text-3 outline-none transition-colors focus:border-accent focus:ring-[3px] focus:ring-ring min-h-[72px] resize-y leading-relaxed ${className}`}
				{...props}
			/>
		</div>
	);
});

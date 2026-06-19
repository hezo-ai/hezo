import { forwardRef, type TextareaHTMLAttributes } from 'react';

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
	label?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
	{ label, className = '', id, ...props },
	ref,
) {
	const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');
	return (
		<div className="flex flex-col gap-1.5">
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

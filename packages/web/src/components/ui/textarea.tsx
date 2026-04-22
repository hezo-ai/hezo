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
				<label
					htmlFor={inputId}
					className="text-xs font-medium uppercase tracking-wider text-text-muted"
				>
					{label}
				</label>
			)}
			<textarea
				ref={ref}
				id={inputId}
				className={`rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-text-subtle outline-none focus:border-border-hover min-h-[80px] resize-y leading-relaxed ${className}`}
				{...props}
			/>
		</div>
	);
});

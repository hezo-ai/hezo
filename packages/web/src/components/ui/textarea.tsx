import type { TextareaHTMLAttributes } from 'react';

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
	label?: string;
}

export function Textarea({ label, className = '', id, ...props }: TextareaProps) {
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
				id={inputId}
				className={`rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px] text-text placeholder:text-text-subtle outline-none focus:border-border-hover min-h-[80px] resize-y leading-relaxed ${className}`}
				{...props}
			/>
		</div>
	);
}

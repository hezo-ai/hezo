import type { TextareaHTMLAttributes } from 'react';

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
	label?: string;
}

export function Textarea({ label, className = '', id, ...props }: TextareaProps) {
	const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');
	return (
		<div className="flex flex-col gap-1.5">
			{label && (
				<label htmlFor={inputId} className="text-sm text-text-muted">
					{label}
				</label>
			)}
			<textarea
				id={inputId}
				className={`rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text placeholder:text-text-subtle outline-none focus:border-primary min-h-[80px] resize-y ${className}`}
				{...props}
			/>
		</div>
	);
}

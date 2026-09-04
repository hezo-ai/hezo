import { type InputHTMLAttributes, type ReactNode, useId } from 'react';
import { touchMinHeightClassName } from './density.js';

export type InputSize = 'sm' | 'md' | 'lg';

/**
 * The field's height presets, the same rows as `Button`'s so a field and the
 * button beside it line up. `md` is Wire's `.hz-input`: 32px tall. Exported so
 * a consumer can size a field-shaped control of its own to the same rows.
 */
export const inputSizeClassName: Record<InputSize, string> = {
	sm: 'h-[26px] px-2 text-[12.5px] rounded-sm',
	md: 'h-8 px-2.5 text-[13px] rounded-md',
	lg: 'h-[38px] px-3 text-sm rounded-md',
};

// The native `size` is a character count; here it is the height preset.
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
	label?: string;
	/** Optional leading icon (e.g. a search glyph), rendered inside the field. */
	icon?: ReactNode;
	/** Class override for the wrapper (e.g. `sm:w-96`, `flex-1`) rather than the field. */
	wrapperClassName?: string;
	/** Height preset, mirroring `Button`'s. Defaults to `md` (32px). */
	size?: InputSize;
}

// Wire's `.hz-input`: strong border, surface bg, accent focus ring.
export function Input({
	label,
	icon,
	size = 'md',
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
			<div
				className={`flex w-full items-center gap-2 border border-border-strong bg-surface transition-colors focus-within:border-accent focus-within:ring-[3px] focus-within:ring-ring ${inputSizeClassName[size]} ${touchMinHeightClassName}`}
			>
				{icon && <span className="shrink-0 text-text-3">{icon}</span>}
				{/* `self-stretch`: the box is a div, so a tap on its padding focuses
				    nothing. The field fills the box's height instead, and centres its
				    text at any height, so the whole border box is the target. */}
				<input
					id={inputId}
					className={`min-w-0 flex-1 self-stretch bg-transparent text-text-1 placeholder:text-text-3 outline-none ${className}`}
					{...props}
				/>
			</div>
		</div>
	);
}

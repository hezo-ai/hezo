import { hitAreaClassName } from './density.js';

export interface ToggleProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
	/**
	 * What the switch turns on.
	 *
	 * Without a name of some kind a switch is announced as "switch, on" with no
	 * subject. Pass this, or `aria-labelledby` where a visible label already says
	 * it, so the state has something to attach to.
	 */
	label?: string;
	/** Names the switch from an element that already shows its label. */
	'aria-labelledby'?: string;
	/** Ties the switch to an external `<label for>`. */
	id?: string;
	className?: string;
}

export function Toggle({
	checked,
	onChange,
	disabled = false,
	label,
	'aria-labelledby': labelledBy,
	id,
	className = '',
}: ToggleProps) {
	return (
		<button
			type="button"
			role="switch"
			id={id}
			aria-checked={checked}
			aria-label={label}
			aria-labelledby={labelledBy}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			// The track stays 32x18; the pseudo-element gives the finger a target the
			// size of a fingertip without changing what anything looks like.
			className={`relative inline-flex w-8 h-[18px] rounded-full transition-colors duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${hitAreaClassName} ${
				checked ? 'bg-accent' : 'bg-border-strong'
			} ${className}`}
		>
			<span
				className={`absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-surface shadow-sm transition-transform duration-200 ${
					checked ? 'translate-x-[14px]' : 'translate-x-0'
				}`}
			/>
		</button>
	);
}

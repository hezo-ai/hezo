import { Eye, EyeOff } from 'lucide-react';
import { type InputHTMLAttributes, useState } from 'react';

interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
	/**
	 * Noun used in the toggle's aria-label ("Show {revealLabel}" / "Hide {revealLabel}").
	 * Defaults to "password". Set a collision-free noun (e.g. "key") when a nearby
	 * `getByLabelText` query would otherwise match the toggle as well as the field.
	 */
	revealLabel?: string;
}

/**
 * Password field with a trailing show/hide toggle. Renders only the input (plus
 * the eye button) — labels stay external so existing `getByLabelText` queries
 * and form layouts keep working. Styled to match the auth-form inputs.
 */
export function PasswordInput({
	className = '',
	revealLabel = 'password',
	...props
}: PasswordInputProps) {
	const [visible, setVisible] = useState(false);
	return (
		<div className="relative">
			<input
				type={visible ? 'text' : 'password'}
				className={`w-full rounded-md border border-border bg-surface px-3 py-2 pr-10 text-sm text-text-1 focus:outline-none focus:ring-2 focus:ring-accent ${className}`}
				{...props}
			/>
			<button
				type="button"
				onClick={() => setVisible((v) => !v)}
				aria-label={`${visible ? 'Hide' : 'Show'} ${revealLabel}`}
				className="absolute inset-y-0 right-0 flex items-center px-3 text-text-3 hover:text-text-1"
			>
				{visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
			</button>
		</div>
	);
}

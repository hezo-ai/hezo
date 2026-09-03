import { Eye, EyeOff } from 'lucide-react';
import { type InputHTMLAttributes, useState } from 'react';

export interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
	/**
	 * The reveal control's name while the field is masked.
	 *
	 * **A whole string, never a noun to build a sentence from.** Assembling one
	 * bakes English word order into every language, and a translator handed only
	 * the noun cannot fix it. Set a name that no nearby `getByLabelText` query
	 * would also match the field by.
	 */
	showLabel?: string;
	/** The reveal control's name while the field is visible. */
	hideLabel?: string;
}

/**
 * Password field with a trailing show/hide toggle. Renders only the input (plus
 * the eye button) — labels stay external so existing `getByLabelText` queries
 * and form layouts keep working. Styled to match the auth-form inputs.
 */
export function PasswordInput({
	className = '',
	showLabel = 'Show password',
	hideLabel = 'Hide password',
	...props
}: PasswordInputProps) {
	const [visible, setVisible] = useState(false);
	return (
		<div className="relative">
			{/* `type` after the spread, deliberately: the prop type forbids one, but a
			    caller spreading a wider object gets past that and would otherwise be
			    able to unmask the field. */}
			<input
				className={`w-full rounded-md border border-border bg-surface px-3 py-2 pr-10 text-sm text-text-1 focus:outline-none focus:ring-2 focus:ring-accent ${className}`}
				{...props}
				type={visible ? 'text' : 'password'}
			/>
			<button
				type="button"
				onClick={() => setVisible((v) => !v)}
				aria-label={visible ? hideLabel : showLabel}
				aria-pressed={visible}
				className="absolute inset-y-0 right-0 flex items-center px-3 text-text-3 hover:text-text-1"
			>
				{visible ? (
					<EyeOff className="w-4 h-4" aria-hidden />
				) : (
					<Eye className="w-4 h-4" aria-hidden />
				)}
			</button>
		</div>
	);
}

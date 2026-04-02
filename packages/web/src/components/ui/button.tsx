import type { ButtonHTMLAttributes } from 'react';

const variants = {
	primary: 'bg-primary text-bg font-medium hover:opacity-85',
	secondary: 'bg-bg-subtle text-text-muted border border-border hover:text-text hover:bg-bg-muted',
	destructive: 'bg-accent-red text-white hover:opacity-85',
	ghost: 'bg-transparent text-text-muted hover:bg-bg-muted hover:text-text',
	outline: 'border border-border bg-transparent text-text hover:bg-bg-muted',
	approve: 'bg-accent-green text-white font-medium hover:opacity-85',
	'danger-text': 'bg-transparent text-accent-red hover:opacity-70',
} as const;

const sizes = {
	sm: 'px-2.5 py-1 text-xs rounded-radius-md',
	md: 'px-4 py-[7px] text-[13px] rounded-radius-md',
	lg: 'px-5 py-2.5 text-sm rounded-radius-md',
} as const;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: keyof typeof variants;
	size?: keyof typeof sizes;
}

export function Button({
	variant = 'primary',
	size = 'md',
	className = '',
	...props
}: ButtonProps) {
	return (
		<button
			className={`inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer ${variants[variant]} ${sizes[size]} ${className}`}
			{...props}
		/>
	);
}

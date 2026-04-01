import type { ButtonHTMLAttributes } from 'react';

const variants = {
	primary: 'bg-primary text-white hover:bg-primary-hover',
	secondary: 'bg-bg-muted text-text hover:bg-bg-elevated',
	destructive: 'bg-danger text-white hover:bg-danger/80',
	ghost: 'bg-transparent text-text-muted hover:bg-bg-muted hover:text-text',
	outline: 'border border-border bg-transparent text-text hover:bg-bg-muted',
} as const;

const sizes = {
	sm: 'px-2.5 py-1 text-xs',
	md: 'px-3.5 py-1.5 text-sm',
	lg: 'px-5 py-2.5 text-base',
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
			className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer ${variants[variant]} ${sizes[size]} ${className}`}
			{...props}
		/>
	);
}

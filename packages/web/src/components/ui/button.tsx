import type { ButtonHTMLAttributes } from 'react';

// Mirrors the Wire spec's `.hz-btn`: neutral `primary` (inverse), red `accent`
// CTA, quiet `secondary`/`ghost`/`outline`, and `danger` variants. Focus shows
// the 3px accent ring (`--color-ring` + accent border).
const variants = {
	primary: 'bg-inverse text-inverse-fg border-transparent hover:opacity-90',
	accent: 'bg-accent-solid text-accent-solid-fg border-transparent hover:bg-accent-hover',
	secondary: 'bg-surface text-text-1 border-border-strong shadow-xs hover:bg-surface-2',
	outline: 'bg-transparent text-text-1 border-border-strong hover:bg-surface-2',
	ghost: 'bg-transparent text-text-2 border-transparent hover:bg-surface-3 hover:text-text-1',
	destructive: 'bg-danger text-danger-solid-fg border-transparent hover:opacity-90',
	approve: 'bg-success text-success-solid-fg border-transparent hover:opacity-90',
	'danger-text': 'bg-transparent text-danger border-transparent hover:bg-danger-soft',
	link: 'bg-transparent text-accent border-none hover:underline',
} as const;

const sizes = {
	sm: 'h-[26px] px-2.5 text-[12.5px] rounded-sm gap-1.5',
	md: 'h-[30px] px-3 text-[13px] rounded-md gap-1.5',
	lg: 'h-[38px] px-4 text-sm rounded-md gap-2',
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
	const sizeCls = variant === 'link' ? 'gap-1.5' : sizes[size];
	return (
		<button
			className={`inline-flex items-center justify-center whitespace-nowrap border font-medium transition-colors cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:border-accent disabled:opacity-45 disabled:pointer-events-none ${variants[variant]} ${sizeCls} ${className}`}
			{...props}
		/>
	);
}

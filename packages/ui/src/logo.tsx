// The Hezo brand mark (red rounded square). Served from /logo.svg (public/).
const sizeMap = {
	sm: 'h-5 w-5',
	md: 'h-6 w-6',
	lg: 'h-8 w-8',
} as const;

interface LogoProps {
	size?: keyof typeof sizeMap;
	/** Render the lowercase "hezo" wordmark next to the mark. */
	wordmark?: boolean;
	className?: string;
}

export function Logo({ size = 'md', wordmark = false, className = '' }: LogoProps) {
	return (
		<span className={`inline-flex items-center gap-2 ${className}`}>
			<img src="/logo.svg" alt="Hezo" className={`${sizeMap[size]} rounded-[22%]`} />
			{wordmark && (
				<span className="text-[15px] font-semibold lowercase tracking-tight text-text-1">hezo</span>
			)}
		</span>
	);
}

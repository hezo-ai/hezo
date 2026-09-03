import type { ReactNode } from 'react';

// A brand mark: a square image, optionally followed by a wordmark.
const sizeMap = {
	sm: 'h-5 w-5',
	md: 'h-6 w-6',
	lg: 'h-8 w-8',
} as const;

export type LogoSize = keyof typeof sizeMap;

export interface LogoProps {
	/**
	 * The mark's image source.
	 *
	 * **Required, because the package ships no image.** A default would name a
	 * path only one app serves, and every other consumer would render a broken
	 * image with nothing in the markup to say why.
	 */
	src: string;
	/** The mark's accessible name - the product it stands for. */
	alt: string;
	size?: LogoSize;
	/** Rendered beside the mark. The word belongs to the consumer, not to this package. */
	wordmark?: ReactNode;
	className?: string;
}

export function Logo({ src, alt, size = 'md', wordmark, className = '' }: LogoProps) {
	return (
		<span className={`inline-flex items-center gap-2 ${className}`}>
			<img src={src} alt={alt} className={`${sizeMap[size]} rounded-[22%]`} />
			{wordmark && (
				<span className="text-[15px] font-semibold tracking-tight text-text-1">{wordmark}</span>
			)}
		</span>
	);
}

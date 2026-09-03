import { useState } from 'react';

// Avatars are monochrome: identity is the initials, and colour is reserved for
// state - a running agent gets a live ring.
const sizeMap = {
	sm: 'w-[26px] h-[26px] text-[10px]',
	// Sized to one line of body text, so the avatar aligns with a single-line
	// message rather than overhanging it.
	chat: 'w-[2.625rem] h-[2.625rem] text-[13px]',
	md: 'w-[36px] h-[36px] text-[13px]',
	lg: 'w-[56px] h-[56px] text-[20px]',
} as const;

export type AvatarSize = keyof typeof sizeMap;

export interface AvatarProps {
	initials: string;
	size?: AvatarSize;
	/**
	 * Who or what the avatar stands for.
	 *
	 * Without it an image-backed avatar has no accessible name at all, and an
	 * initials-backed one is announced two letters at a time.
	 */
	label?: string;
	/** Marks the subject as currently working, with a live ring and a spoken state. */
	running?: boolean;
	/** Names the running state for assistive tech. English default. */
	runningLabel?: string;
	/** Optional image (e.g. a project icon). Falls back to initials on load error. */
	imageUrl?: string | null;
	className?: string;
}

/** First letters of the first two words, or the first two characters of a single word. */
export function getInitials(name: string): string {
	const words = name.split(/\s+/).filter(Boolean);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

export function Avatar({
	initials,
	size = 'md',
	label,
	running = false,
	runningLabel = 'Running',
	imageUrl,
	className = '',
}: AvatarProps) {
	// Track the specific URL that failed so a later icon change re-attempts the image.
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const showImage = !!imageUrl && failedUrl !== imageUrl;
	return (
		<div
			// The 1px border gives *initials* contrast against the surface. A
			// full-bleed image needs no border — keeping it would add a stray grey
			// ring between the image and any active/live ring (looks mis-spaced).
			className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-3 font-semibold text-text-2 ${
				showImage ? '' : 'border border-border'
			} ${sizeMap[size]} ${
				running ? 'ring-2 ring-live ring-offset-2 ring-offset-bg' : ''
			} ${className}`}
		>
			{showImage ? (
				// Named where the caller says who this is; decorative otherwise, since an
				// unlabelled avatar sits beside the name it stands for. An empty `alt` on
				// both left every image-backed avatar with no accessible name at all.
				<img
					src={imageUrl}
					alt={label ?? ''}
					className="h-full w-full object-cover"
					onError={() => setFailedUrl(imageUrl)}
				/>
			) : (
				initials.slice(0, 2).toUpperCase()
			)}
			{/* The live ring is the only thing that shows a running agent, so the state
			    is said as well as drawn. */}
			{running && <span className="sr-only">{runningLabel}</span>}
		</div>
	);
}

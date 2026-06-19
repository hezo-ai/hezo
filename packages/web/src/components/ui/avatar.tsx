// Avatars are monochrome (the spec: "monochrome, color = state"). Identity is
// the initials; state (a running agent) is shown by a cyan `--live` ring.
const sizeMap = {
	sm: 'w-[26px] h-[26px] text-[10px]',
	md: 'w-[36px] h-[36px] text-[13px]',
	lg: 'w-[56px] h-[56px] text-[20px]',
} as const;

/** Retained for API compatibility; avatars no longer tint per colour. */
export type AvatarColor = 'blue' | 'green' | 'amber' | 'purple' | 'red' | 'neutral';
const AVATAR_COLORS: AvatarColor[] = ['blue', 'green', 'amber', 'purple', 'red'];

interface AvatarProps {
	initials: string;
	size?: keyof typeof sizeMap;
	/** Accepted for back-compat but no longer changes the (monochrome) fill. */
	color?: AvatarColor;
	/** Running agents get a cyan live ring. */
	running?: boolean;
	className?: string;
}

/** First letters of the first two words, or the first two characters of a single word. */
export function getInitials(name: string): string {
	const words = name.split(/\s+/).filter(Boolean);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

export function avatarColorFromString(str: string): AvatarColor {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash);
	}
	return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function Avatar({ initials, size = 'md', running = false, className = '' }: AvatarProps) {
	return (
		<div
			className={`inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-surface-3 font-semibold text-text-2 ${
				sizeMap[size]
			} ${running ? 'ring-2 ring-live ring-offset-2 ring-offset-bg' : ''} ${className}`}
		>
			{initials.slice(0, 2).toUpperCase()}
		</div>
	);
}

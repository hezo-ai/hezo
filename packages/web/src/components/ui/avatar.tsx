const sizeMap = {
	sm: 'w-[26px] h-[26px] text-[10px]',
	md: 'w-[36px] h-[36px] text-[13px]',
	lg: 'w-[56px] h-[56px] text-[20px]',
} as const;

const colorMap = {
	blue: 'bg-accent-blue-bg text-accent-blue-text',
	green: 'bg-accent-green-bg text-accent-green-text',
	amber: 'bg-accent-amber-bg text-accent-amber-text',
	purple: 'bg-accent-purple-bg text-accent-purple-text',
	red: 'bg-accent-red-bg text-accent-red-text',
	neutral: 'bg-bg-subtle text-text-muted',
} as const;

const AVATAR_COLORS = Object.keys(colorMap).filter((c) => c !== 'neutral') as AvatarColor[];

export type AvatarColor = keyof typeof colorMap;

interface AvatarProps {
	initials: string;
	size?: keyof typeof sizeMap;
	color?: AvatarColor;
	className?: string;
}

export function avatarColorFromString(str: string): AvatarColor {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash);
	}
	return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function Avatar({ initials, size = 'md', color = 'blue', className = '' }: AvatarProps) {
	return (
		<div
			className={`inline-flex items-center justify-center rounded-full font-medium shrink-0 ${sizeMap[size]} ${colorMap[color]} ${className}`}
		>
			{initials.slice(0, 2).toUpperCase()}
		</div>
	);
}

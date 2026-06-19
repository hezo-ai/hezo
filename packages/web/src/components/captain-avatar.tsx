/** Home intake bubble min-height (py-2.5 + one line); avatar `chat` size matches this. */
export const captainChatBubbleMinHClass = 'min-h-[2.625rem]';
const captainChatAvatarSizeClass = 'w-[2.625rem] h-[2.625rem]';

const sizeMap = {
	sm: 'w-[26px] h-[26px]',
	chat: captainChatAvatarSizeClass,
	md: 'w-[36px] h-[36px]',
	lg: 'w-[56px] h-[56px]',
} as const;

interface CaptainAvatarProps {
	size?: keyof typeof sizeMap;
	className?: string;
}

/** Cartoon-style female Captain avatar (inline SVG, theme-independent). */
export function CaptainAvatar({ size = 'md', className = '' }: CaptainAvatarProps) {
	return (
		<span
			role="img"
			aria-label="Captain"
			className={`inline-block shrink-0 rounded-full overflow-hidden ring-1 ring-border bg-purple-soft ${sizeMap[size]} ${className}`}
		>
			<svg viewBox="0 0 64 64" className="w-full h-full" aria-hidden>
				<title>Captain</title>
				<rect width="64" height="64" fill="#EEEDFE" />
				{/* Hair */}
				<path
					d="M12 28c2-14 14-22 32-20 10 1 18 8 20 18 2 12-2 22-10 26H14c-6-6-8-18-2-24z"
					fill="#3C3489"
				/>
				<path
					d="M18 24c6-10 18-14 28-10 6 3 10 10 10 18 0 8-4 14-10 16-12 2-22-2-28-10-14-4-26 2-34 12z"
					fill="#534AB7"
				/>
				{/* Face */}
				<ellipse cx="32" cy="34" rx="17" ry="18" fill="#F5D0B8" />
				{/* Captain cap */}
				<path d="M14 30h36l-4 8H18z" fill="#185FA5" />
				<path d="M20 26h24l2 4H18z" fill="#0C447C" />
				<ellipse cx="32" cy="28" rx="14" ry="3" fill="#185FA5" />
				{/* Eyes */}
				<ellipse cx="25" cy="34" rx="2.2" ry="2.8" fill="#1a1a1a" />
				<ellipse cx="39" cy="34" rx="2.2" ry="2.8" fill="#1a1a1a" />
				<circle cx="26" cy="33" r="0.8" fill="#fff" />
				<circle cx="40" cy="33" r="0.8" fill="#fff" />
				{/* Smile */}
				<path
					d="M24 41c3 4 13 4 16 0"
					fill="none"
					stroke="#993556"
					strokeWidth="1.8"
					strokeLinecap="round"
				/>
				{/* Ears hint */}
				<ellipse cx="15" cy="35" rx="2.5" ry="3.5" fill="#E8B89A" />
				<ellipse cx="49" cy="35" rx="2.5" ry="3.5" fill="#E8B89A" />
			</svg>
		</span>
	);
}

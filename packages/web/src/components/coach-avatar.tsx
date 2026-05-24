const sizeMap = {
	sm: 'w-[26px] h-[26px]',
	chat: 'w-[2.625rem] h-[2.625rem]',
	md: 'w-[36px] h-[36px]',
	lg: 'w-[56px] h-[56px]',
} as const;

interface CoachAvatarProps {
	size?: keyof typeof sizeMap;
	className?: string;
}

/** Cartoon-style male Coach avatar (inline SVG, theme-independent). */
export function CoachAvatar({ size = 'md', className = '' }: CoachAvatarProps) {
	return (
		<span
			role="img"
			aria-label="Coach"
			className={`inline-block shrink-0 rounded-full overflow-hidden ring-1 ring-border bg-accent-green-bg ${sizeMap[size]} ${className}`}
		>
			<svg viewBox="0 0 64 64" className="w-full h-full" aria-hidden>
				<title>Coach</title>
				<rect width="64" height="64" fill="#E1F5EE" />
				{/* Shirt / collar */}
				<path d="M8 52h48v12H8z" fill="#0D9488" />
				<path d="M22 48h20l-2 6H24z" fill="#14B8A6" />
				{/* Neck */}
				<rect x="26" y="44" width="12" height="8" fill="#E8B89A" />
				{/* Face */}
				<ellipse cx="32" cy="33" rx="16" ry="17" fill="#F0C9A8" />
				{/* Ears */}
				<ellipse cx="16" cy="33" rx="2.8" ry="4" fill="#E0B090" />
				<ellipse cx="48" cy="33" rx="2.8" ry="4" fill="#E0B090" />
				{/* Short hair */}
				<path
					d="M14 26c2-12 12-20 28-18 12 1 20 8 22 18 1 6-2 10-8 12-4 2-10 2-16 0-10-2-18-6-26-12z"
					fill="#1B4332"
				/>
				<path d="M18 22c8-8 20-10 28-6 4 2 8 8 8 14 0 4-14 4-22 0-8-4-14-8-14-8z" fill="#2D6A4F" />
				{/* Glasses */}
				<rect
					x="18"
					y="30"
					width="11"
					height="7"
					rx="2"
					fill="none"
					stroke="#065F46"
					strokeWidth="1.6"
				/>
				<rect
					x="35"
					y="30"
					width="11"
					height="7"
					rx="2"
					fill="none"
					stroke="#065F46"
					strokeWidth="1.6"
				/>
				<path d="M29 33h6" stroke="#065F46" strokeWidth="1.4" strokeLinecap="round" />
				{/* Eyes */}
				<ellipse cx="23.5" cy="33" rx="2" ry="2.5" fill="#1a1a1a" />
				<ellipse cx="40.5" cy="33" rx="2" ry="2.5" fill="#1a1a1a" />
				<circle cx="24.2" cy="32.2" r="0.7" fill="#fff" />
				<circle cx="41.2" cy="32.2" r="0.7" fill="#fff" />
				{/* Brows */}
				<path
					d="M19 27.5c3-1.5 7-1.5 10 0"
					fill="none"
					stroke="#1B4332"
					strokeWidth="2"
					strokeLinecap="round"
				/>
				<path
					d="M35 27.5c3-1.5 7-1.5 10 0"
					fill="none"
					stroke="#1B4332"
					strokeWidth="2"
					strokeLinecap="round"
				/>
				{/* Friendly smile */}
				<path
					d="M24 40c4 3 12 3 16 0"
					fill="none"
					stroke="#2D6A4F"
					strokeWidth="1.8"
					strokeLinecap="round"
				/>
				{/* Light stubble */}
				<ellipse cx="32" cy="42" rx="9" ry="4" fill="#D4A882" opacity="0.35" />
			</svg>
		</span>
	);
}

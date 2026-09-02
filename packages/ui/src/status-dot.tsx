// Wire's `.hz-dot`: color = state. Running agents read as cyan "live"; paused as
// amber; idle/disabled stay neutral. `pulse` adds a soft glow ring.
const statusMap = {
	active: 'bg-live',
	idle: 'bg-text-3',
	paused: 'bg-warning',
	disabled: 'bg-border-strong',
} as const;

const glowMap = {
	active: 'ring-live/40',
	idle: 'ring-text-3/30',
	paused: 'ring-warning/40',
	disabled: 'ring-border-strong/30',
} as const;

interface StatusDotProps {
	status: keyof typeof statusMap;
	pulse?: boolean;
	/**
	 * When set, the dot is exposed to assistive tech (and tests) as `role="img"`
	 * with this accessible name, and gets a native `title` tooltip. Omit to keep
	 * the dot purely decorative (e.g. when an adjacent label already names it).
	 */
	label?: string;
	className?: string;
}

export function StatusDot({ status, pulse, label, className = '' }: StatusDotProps) {
	// `role` + `aria-label` are set together — a generic <span> (no role) doesn't
	// support `aria-label`, so the named case opts into the `img` role.
	const a11y = label ? { role: 'img' as const, 'aria-label': label, title: label } : {};
	return (
		<span
			{...a11y}
			className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${statusMap[status]} ${
				pulse ? `animate-pulse ring-[3px] ${glowMap[status]}` : ''
			} ${className}`}
		/>
	);
}

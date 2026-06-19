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
	className?: string;
}

export function StatusDot({ status, pulse, className = '' }: StatusDotProps) {
	return (
		<span
			className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${statusMap[status]} ${
				pulse ? `animate-pulse ring-[3px] ${glowMap[status]}` : ''
			} ${className}`}
		/>
	);
}

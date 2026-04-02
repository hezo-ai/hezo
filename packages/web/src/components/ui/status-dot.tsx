const statusMap = {
	active: 'bg-accent-green',
	idle: 'bg-text',
	paused: 'bg-accent-red',
	disabled: 'bg-text-subtle',
} as const;

interface StatusDotProps {
	status: keyof typeof statusMap;
	pulse?: boolean;
	className?: string;
}

export function StatusDot({ status, pulse, className = '' }: StatusDotProps) {
	return (
		<span
			className={`inline-block w-[5px] h-[5px] rounded-full shrink-0 ${statusMap[status]} ${pulse ? 'animate-pulse' : ''} ${className}`}
		/>
	);
}

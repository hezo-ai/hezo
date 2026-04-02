const statusMap = {
	active: 'bg-accent-green',
	idle: 'bg-text-subtle',
	paused: 'bg-accent-amber',
} as const;

interface StatusDotProps {
	status: keyof typeof statusMap;
	className?: string;
}

export function StatusDot({ status, className = '' }: StatusDotProps) {
	return (
		<span
			className={`inline-block w-[5px] h-[5px] rounded-full shrink-0 ${statusMap[status]} ${className}`}
		/>
	);
}

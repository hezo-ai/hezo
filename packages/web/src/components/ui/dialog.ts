const base =
	'fixed inset-0 z-50 flex flex-col bg-bg-elevated p-4 overflow-y-auto outline-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-h-[90vh] sm:rounded-xl sm:border sm:border-border sm:p-6 sm:shadow-2xl';

export const dialogContentClassName = {
	sm: `${base} sm:max-w-sm`,
	md: `${base} sm:max-w-md`,
	lg: `${base} sm:max-w-lg`,
	xl: `${base} sm:max-w-xl`,
} as const;

export const dialogOverlayClassName = 'fixed inset-0 bg-black/60 backdrop-blur-sm z-40';

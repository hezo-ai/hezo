const base =
	'fixed inset-0 z-50 flex flex-col bg-surface p-4 overflow-y-auto outline-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-full sm:max-h-[90vh] sm:rounded-lg sm:border sm:border-border sm:p-6 sm:shadow-lg';

export const dialogContentClassName = {
	sm: `${base} sm:max-w-sm`,
	md: `${base} sm:max-w-md`,
	lg: `${base} sm:max-w-lg`,
	xl: `${base} sm:max-w-xl`,
} as const;

/**
 * Fullscreen dialog content: fills the viewport (with a small inset on desktop)
 * instead of centring at a fixed max-width. `overflow-hidden` so an inner
 * `flex flex-col` body can own its own scrolling — used by dialogs that let a
 * field grow to fill the space (e.g. the create-task description).
 */
export const fullscreenContentClassName =
	'fixed inset-0 z-50 flex flex-col bg-surface p-4 overflow-hidden outline-none sm:inset-4 sm:rounded-lg sm:border sm:border-border sm:p-6 sm:shadow-lg';

export const dialogOverlayClassName = 'fixed inset-0 bg-[var(--overlay)] backdrop-blur-sm z-40';

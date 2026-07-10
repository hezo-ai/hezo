import { useSyncExternalStore } from 'react';

export interface ToastLink {
	label: string;
	/** In-app path (used as the anchor's href, so it survives middle-click). */
	href: string;
	/** SPA navigation for a plain click; without it the anchor navigates natively. */
	onNavigate?: () => void;
}

export interface Toast {
	id: number;
	variant: 'error' | 'info' | 'success';
	message: string;
	/** Optional trailing action link (e.g. "View comment" on a cross-page success). */
	link?: ToastLink;
}

type Listener = (toasts: Toast[]) => void;

let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<Listener>();

function emit() {
	for (const l of listeners) l(toasts);
}

function push(t: Omit<Toast, 'id'>): number {
	const id = nextId++;
	toasts = [...toasts, { id, ...t }];
	emit();
	return id;
}

function dismiss(id: number) {
	toasts = toasts.filter((t) => t.id !== id);
	emit();
}

export const toast = {
	error(message: string) {
		return push({ variant: 'error', message });
	},
	/** A neutral, non-alarming notice (e.g. "nothing to do") — styled distinctly from errors. */
	info(message: string) {
		return push({ variant: 'info', message });
	},
	/**
	 * Confirmation of an action whose result lives on a DIFFERENT page, carrying
	 * the link there (e.g. a review handoff posted onto a task). Same-page
	 * successes stay untoasted — the UI change itself is the confirmation.
	 */
	success(message: string, opts?: { link?: ToastLink }) {
		return push({ variant: 'success', message, link: opts?.link });
	},
	dismiss,
};

export function useToasts(): Toast[] {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		() => toasts,
		() => toasts,
	);
}

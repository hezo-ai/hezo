import { useSyncExternalStore } from 'react';

export interface Toast {
	id: number;
	variant: 'error';
	message: string;
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

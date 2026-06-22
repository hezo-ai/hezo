import { createContext, useContext } from 'react';

/** A document that can be shown in the task-detail preview panel. */
export interface PreviewItem {
	/** Project slug (route-param form) — used for both the API path and preview URL. */
	projectId: string;
	projectSlug: string;
	filename: string;
	size?: number;
	updatedAt?: string;
}

type OpenPreview = (item: PreviewItem) => void;

/**
 * Surfaces that host a preview panel (today: the task-detail page) provide an
 * opener through this context. When present, in-comment doc mentions open in the
 * panel instead of a new tab; when absent (docs page, CEO chat) they keep their
 * new-tab links. Asset mentions always open in a new tab regardless of surface,
 * so they never use this. Defaulting to `null` is what lets the same MarkdownProse
 * render behave differently per surface without a prop drill.
 */
const PreviewContext = createContext<OpenPreview | null>(null);

export const PreviewProvider = PreviewContext.Provider;

/** The open-preview handler for the current surface, or null when none hosts a panel. */
export function useOpenPreview(): OpenPreview | null {
	return useContext(PreviewContext);
}

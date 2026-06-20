import { createContext, useContext } from 'react';

/** A document or asset that can be shown in the task-detail preview panel. */
export interface PreviewItem {
	kind: 'doc' | 'asset';
	/** Project slug (route-param form) — used for both the API path and preview URL. */
	projectId: string;
	projectSlug: string;
	filename: string;
	/** Asset only — MIME type, drives how the asset is rendered. */
	contentType?: string;
	/** Asset only — signed URL to fetch/display the asset and open it in a new tab. */
	url?: string;
	size?: number;
	updatedAt?: string;
}

type OpenPreview = (item: PreviewItem) => void;

/**
 * Surfaces that host a preview panel (today: the task-detail page) provide an
 * opener through this context. When present, in-comment doc/asset mentions open
 * in the panel instead of a new tab; when absent (docs/assets pages, CEO chat)
 * the mentions keep their new-tab links. Defaulting to `null` is what lets the
 * same MarkdownProse render behave differently per surface without a prop drill.
 */
const PreviewContext = createContext<OpenPreview | null>(null);

export const PreviewProvider = PreviewContext.Provider;

/** The open-preview handler for the current surface, or null when none hosts a panel. */
export function useOpenPreview(): OpenPreview | null {
	return useContext(PreviewContext);
}

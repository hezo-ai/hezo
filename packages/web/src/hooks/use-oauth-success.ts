import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

/**
 * Refetch `queryKey` when the OAuth popup reports it finished.
 *
 * Every surface that opens the authorize popup needs this: the write happens in
 * the popup, so nothing in this tab's own mutation lifecycle knows the connector
 * changed, and without it a completed (re)connection only shows up on a reload.
 *
 * The popup posts `{type: 'hezo-oauth-success'}` via `window.opener.postMessage`
 * from the callback page (`routes/oauth.ts:buildCallbackPage`), which lives on
 * the server origin while the app is on the web origin — so this can't require
 * `e.origin === window.location.origin` and gates on the message type instead.
 * The payload is a type tag, not credentials.
 */
export function useOAuthSuccessRefetch(queryKey: QueryKey): void {
	const queryClient = useQueryClient();
	// Read through a ref so an inline-built key doesn't re-subscribe every render.
	const keyRef = useRef(queryKey);
	keyRef.current = queryKey;

	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			if (!e.data || typeof e.data !== 'object') return;
			if ((e.data as { type?: string }).type !== 'hezo-oauth-success') return;
			queryClient.invalidateQueries({ queryKey: keyRef.current });
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [queryClient]);
}

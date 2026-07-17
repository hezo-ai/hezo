import { useCallback, useEffect, useState } from 'react';

interface SignedUrlText {
	/** The fetched body; `null` while loading or after an error. */
	text: string | null;
	error: string | null;
	/** Refetch after an error (e.g. the signed URL expired mid-view). */
	reload: () => void;
}

/**
 * Fetch a text asset's body from its signed URL (the public asset route serves
 * the stored bytes; no auth header — the signature is in the URL).
 *
 * The fetch is keyed on the asset's *identity* — the URL path (`/api/assets/
 * <id>`) — not on the whole URL. The query string carries only a short-lived
 * `exp`/`sig` that every assets-list refetch rotates (a fresh `Date.now()` per
 * request), and re-fetching the same immutable bytes on a merely-rotated
 * signature is wasted work. Worse, blanking `text` for a frame unmounts the
 * asset viewer's prose, which collapses the page and yanks the reader back to
 * the top mid-review — the bug this keying fixes. An asset overwrite swaps the
 * id (and thus the path), so genuinely new content still triggers a refetch;
 * `reload()` forces one with the latest signature after an error (e.g. the URL
 * expired before the first load landed).
 */
export function useSignedUrlText(url: string | undefined): SignedUrlText {
	const [text, setText] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);

	// The asset's stable identity: everything before the signing query string.
	const identity = url ? url.split('?')[0] : undefined;

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional — fetch the latest signed `url`, but re-run only when the asset `identity` (path) changes or `nonce` (the manual retry) bumps. A rotated signature for the same asset must NOT re-run, so `url` is deliberately excluded from the deps.
	useEffect(() => {
		if (!url) return;
		let cancelled = false;
		setText(null);
		setError(null);
		(async () => {
			try {
				const res = await fetch(url);
				if (!res.ok) throw new Error(`Failed to load asset (${res.status})`);
				const body = await res.text();
				if (!cancelled) setText(body);
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load asset');
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [identity, nonce]);

	const reload = useCallback(() => setNonce((n) => n + 1), []);
	return { text, error, reload };
}

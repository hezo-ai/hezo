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
 * the stored bytes; no auth header — the signature is in the URL). Re-runs when
 * the URL changes: a list refetch hands out a fresh signature, and an agent
 * overwrite swaps the asset id inside the URL entirely.
 */
export function useSignedUrlText(url: string | undefined): SignedUrlText {
	const [text, setText] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is the manual retry trigger — bumping it re-runs the fetch for the same URL
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
	}, [url, nonce]);

	const reload = useCallback(() => setNonce((n) => n + 1), []);
	return { text, error, reload };
}

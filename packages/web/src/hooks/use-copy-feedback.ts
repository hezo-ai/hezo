import { useCallback, useEffect, useRef, useState } from 'react';
import { copyToClipboard } from '../lib/clipboard';

/** How long the confirmation stays up before the icon reverts. */
const DEFAULT_RESET_MS = 1500;

/**
 * Copy text to the clipboard and hold a transient "copied" flag.
 *
 * Every copy affordance in the app runs the same state machine: on a successful
 * copy flip to the check icon, then revert after ~1.5s - and each needs the same
 * timer bookkeeping (clear a pending timer on a re-copy so a fast double click
 * doesn't revert early, and on unmount so the timeout never fires into an
 * unmounted component). That is this hook.
 *
 * Callers keep their own markup: the affordances differ in size, label, tooltip
 * and placement, and only the state is shared - which is why this is a hook and
 * not a `<CopyButton>` carrying a prop for each of those differences.
 */
export function useCopyFeedback(resetMs: number = DEFAULT_RESET_MS) {
	const [copied, setCopied] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, []);

	const copy = useCallback(
		async (text: string): Promise<boolean> => {
			if (!(await copyToClipboard(text))) return false;
			setCopied(true);
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			timeoutRef.current = setTimeout(() => setCopied(false), resetMs);
			return true;
		},
		[resetMs],
	);

	return { copied, copy };
}

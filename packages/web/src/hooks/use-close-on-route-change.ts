import { useLocation } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

/**
 * Close a transient overlay — a modal dialog, the mobile nav drawer, a collapsed
 * menu — when the app navigates to a different page.
 *
 * Not every overlay unmounts on navigation. The ones rendered under `<Outlet />`
 * do, by accident of where they live; the ones rendered by the shell chrome in
 * `routes/__root.tsx` sit ABOVE the `<Outlet />` and never unmount, so their
 * `open` state survives a client-side navigation. The failure mode is a link
 * inside the overlay: the page underneath swaps, the overlay does not, and a
 * full-screen Radix modal (overlay `z-[80]`, content `z-[90]`) is left covering
 * the page the reader just asked for, with no way through but its close button.
 * That is what the create-project dialog's "View container" link did while the
 * HQ container was provisioning.
 *
 * Closing at the *route* rather than in each link's `onClick` is deliberate: the
 * navigation can come from somewhere the overlay never sees. The global
 * Cmd/Ctrl+K handler is a `window` keydown listener (`ShellChrome`) and Radix
 * only intercepts Escape, so the search palette opens on top of an open dialog
 * and navigates from there. A per-link handler would miss that, and would miss
 * the next link somebody adds.
 *
 * Two guards keep it from firing when nothing actually changed — the same two the
 * `<main>` scroll reset in `routes/__root.tsx` needs:
 *   - Only a PATHNAME change counts. Search params are page state (a task filter,
 *     an assets folder) and a hash is an in-page jump — notably the comment
 *     deep-link executor strips `#comment-…` once it settles, and treating that
 *     as a page change would shut the overlay under the reader.
 *   - The first effect run never closes. Mount is not a navigation.
 *
 * `open` is passed in so a closed overlay's `onClose` is never called
 * spuriously — a `Dialog.Root`'s `onOpenChange(false)` should mean the open
 * state actually changed.
 */
export function useCloseOnRouteChange(open: boolean, onClose: () => void): void {
	const pathname = useLocation({ select: (l) => l.pathname });
	const lastPathnameRef = useRef(pathname);
	// Read the callback through a ref so the natural call shape — an inline arrow —
	// doesn't re-run the effect on every render and re-arm it against a pathname
	// that never moved.
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useEffect(() => {
		const pathnameChanged = lastPathnameRef.current !== pathname;
		// Track the pathname even while closed, so reopening never compares against
		// a stale value and closes on the next unrelated render.
		lastPathnameRef.current = pathname;
		if (!pathnameChanged || !open) return;
		onCloseRef.current();
	}, [pathname, open]);
}

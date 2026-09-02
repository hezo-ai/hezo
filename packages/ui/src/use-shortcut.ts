import { useEffect, useRef } from 'react';
import {
	isEditableTarget,
	isMacPlatform,
	matchesShortcut,
	parseShortcut,
	shortcutBypassesInput,
} from './shortcuts.js';

interface UseShortcutOptions {
	/** When false, the listener is not registered (e.g. a disabled button). */
	enabled?: boolean;
}

/**
 * Register a document-level keydown that invokes `handler` when `spec` matches.
 *
 * Guards, so a shortcut never fires when it shouldn't:
 *  - IME composition in progress → ignored.
 *  - A modifier-less shortcut (bare letter) while a text field is focused →
 *    ignored, so typing never triggers a button. Modifier shortcuts (⌘/Ctrl…)
 *    still fire inside inputs, which is what "⌘⏎ to submit" needs.
 *  - Already handled (`defaultPrevented`) → ignored, so we never double-fire
 *    behind another handler that already claimed the key.
 *
 * `handler` is read through a ref, so a changing closure doesn't re-bind the
 * listener; only `spec`/`enabled` do.
 */
export function useShortcut(
	spec: string | undefined,
	handler: () => void,
	{ enabled = true }: UseShortcutOptions = {},
): void {
	const handlerRef = useRef(handler);
	handlerRef.current = handler;

	useEffect(() => {
		if (!spec || !enabled) return;
		const parsed = parseShortcut(spec);
		if (!parsed.key) return;
		const isMac = isMacPlatform();
		const bypassesInput = shortcutBypassesInput(parsed);

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.isComposing || event.defaultPrevented) return;
			if (!bypassesInput && isEditableTarget(event.target)) return;
			if (!matchesShortcut(spec, event, isMac)) return;
			event.preventDefault();
			handlerRef.current();
		};

		document.addEventListener('keydown', onKeyDown);
		return () => document.removeEventListener('keydown', onKeyDown);
	}, [spec, enabled]);
}

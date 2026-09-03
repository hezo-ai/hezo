import { useEffect, useRef } from 'react';
import {
	isEditableTarget,
	isMacPlatform,
	matchesShortcut,
	parseShortcut,
	shortcutBypassesInput,
} from './shortcuts.js';

export interface UseShortcutOptions {
	/** When false, the binding is not registered (e.g. a disabled button). */
	enabled?: boolean;
}

/** One entry on the shared stack. */
interface ShortcutBinding {
	spec: string;
	/** Precomputed once: a non-Shift modifier spec fires inside text fields. */
	bypassesInput: boolean;
	/** Reads the caller's handler through a ref, so a changing closure never re-registers. */
	run: () => void;
}

/**
 * One listener, one stack, one winner.
 *
 * Every binding used to add its own keydown listener and defer to whoever had
 * already claimed the key, which made the *first* binding registered win. That is
 * backwards for the case it decides: a confirmation opened over a page loses the
 * key to the button underneath it. This stack is read from the top, so the most
 * recently registered binding fires and nothing else does, and the key returns to
 * the one below when it unregisters.
 */
const stack: ShortcutBinding[] = [];
let listening = false;

function onKeyDown(event: KeyboardEvent) {
	// Guards on the whole stack rather than on one binding:
	//  - composition in progress, so the keystroke belongs to the input method.
	//  - already claimed, by a handler nearer the target or an earlier
	//    capture-phase one, so no binding may fire behind it.
	if (event.isComposing || event.defaultPrevented) return;

	const isMac = isMacPlatform();
	for (let i = stack.length - 1; i >= 0; i--) {
		const binding = stack[i];
		// Per binding, because the binding's own spec decides it: a modifier-less
		// shortcut never fires while a text field is focused, so typing cannot
		// trigger a button.
		if (!binding.bypassesInput && isEditableTarget(event.target)) continue;
		if (!matchesShortcut(binding.spec, event, isMac)) continue;
		// Before the handler runs: it suppresses the browser's own action, and it is
		// what a handler further along the path reads to see the key was claimed.
		event.preventDefault();
		binding.run();
		return;
	}
}

function register(binding: ShortcutBinding): () => void {
	stack.push(binding);
	if (!listening) {
		// Bubble phase, deliberately. React attaches its own handlers below this
		// node, so a component's own key handler still wins; the dialog primitives
		// listen in the capture phase, so an open layer claims its dismiss key
		// before this runs. Capture here would invert both, and would make dialog
		// dismissal depend on which listener installed first.
		document.addEventListener('keydown', onKeyDown);
		listening = true;
	}
	return () => {
		// By identity, never by position: two bindings unregistering in the same
		// commit do so in whatever order cleanup runs, and removing one from the
		// middle has to leave every other binding's rank intact.
		const at = stack.indexOf(binding);
		if (at !== -1) stack.splice(at, 1);
		if (stack.length === 0 && listening) {
			document.removeEventListener('keydown', onKeyDown);
			listening = false;
		}
	};
}

/**
 * Bind `handler` to `spec` for as long as the component is mounted and enabled.
 *
 * The most recently registered enabled binding for a key is the one that fires;
 * when it unregisters, the binding below it takes the key back.
 *
 * Guards, so a shortcut never fires when it shouldn't:
 *  - composition in progress → ignored.
 *  - a modifier-less shortcut (a bare letter) while a text field is focused →
 *    ignored, so typing never triggers a button. Modifier shortcuts still fire
 *    inside inputs, which is what "⌘⏎ to submit" needs.
 *  - already handled by another listener → ignored, so nothing double-fires
 *    behind a handler that already claimed the key.
 *
 * `handler` is read through a ref, so a changing closure doesn't re-bind.
 */
export function useShortcut(
	spec: string | undefined,
	handler: () => void,
	{ enabled = true }: UseShortcutOptions = {},
): void {
	const handlerRef = useRef(handler);
	handlerRef.current = handler;

	// The dependencies are exactly the two values that change a registration. An
	// unrelated re-render must not re-run this: a binding that moved to the top of
	// the stack whenever its parent rendered would make "most recent" mean "most
	// recently rendered", which is not a property a caller can reason about.
	useEffect(() => {
		if (!spec || !enabled) return;
		return register({
			spec,
			bypassesInput: shortcutBypassesInput(parseShortcut(spec)),
			run: () => handlerRef.current(),
		});
	}, [spec, enabled]);
}

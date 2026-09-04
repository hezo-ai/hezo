import {
	ariaKeyshortcuts,
	formatShortcut,
	isEditableTarget,
	matchesShortcut,
	parseShortcut,
	shortcutBypassesInput,
} from '@hezo/ui';
import { expect, test } from 'vitest';

/**
 * The shortcut grammar, on both platforms.
 *
 * These take `isMac` explicitly, which is the whole reason they were written as
 * pure functions - the module's own platform check caches its answer for the
 * life of the process, so a spec that relied on it could only ever exercise the
 * host it runs on.
 */

test('a spec parses its modifiers and its key', () => {
	expect(parseShortcut('mod+Shift+Enter')).toEqual({
		mod: true,
		ctrl: false,
		meta: false,
		alt: false,
		shift: true,
		key: 'Enter',
	});
	expect(parseShortcut('esc').key).toBe('Escape');
	expect(parseShortcut('space').key).toBe(' ');
	expect(parseShortcut('up').key).toBe('ArrowUp');
});

test('a spec naming modifiers but no key is refused', () => {
	// Registering nothing would leave a button rendering a keycap for a binding
	// that can never fire, with nothing to say so.
	expect(() => parseShortcut('mod')).toThrow(/no key/);
	expect(() => parseShortcut('mod+shift')).toThrow(/no key/);
});

test('a modifier other than Shift lets a shortcut fire while typing', () => {
	expect(shortcutBypassesInput(parseShortcut('mod+Enter'))).toBe(true);
	expect(shortcutBypassesInput(parseShortcut('alt+k'))).toBe(true);
	// Shift+Arrow inside a field means "extend the selection", so a Shift-only
	// spec is treated like a bare key.
	expect(shortcutBypassesInput(parseShortcut('shift+ArrowUp'))).toBe(false);
	expect(shortcutBypassesInput(parseShortcut('r'))).toBe(false);
});

test('the chip names every modifier the match requires, on either platform', () => {
	expect(formatShortcut('mod+Enter', true)).toBe('⌘⏎');
	expect(formatShortcut('mod+Enter', false)).toBe('Ctrl+⏎');
	expect(formatShortcut('mod+Shift+k', true)).toBe('⇧⌘K');

	// An explicit cmd/win spec still requires the Meta key away from a mac, so a
	// chip that named only the letter promised a key press that does nothing.
	expect(formatShortcut('cmd+k', false)).toBe('Meta+K');
	expect(matchesShortcut('cmd+k', keyEvent({ key: 'k' }), false)).toBe(false);
	expect(matchesShortcut('cmd+k', keyEvent({ key: 'k', metaKey: true }), false)).toBe(true);
});

test('the ARIA value names the space key rather than writing one', () => {
	// The attribute holds a space-separated list, so a literal space would split
	// one shortcut into two unusable halves.
	expect(ariaKeyshortcuts('mod+space', true)).toBe('Meta+Space');
	expect(ariaKeyshortcuts('mod+space', false)).toBe('Control+Space');
	expect(ariaKeyshortcuts('mod+Enter', true)).toBe('Meta+Enter');
	expect(ariaKeyshortcuts('mod+k', false)).toBe('Control+K');
});

test('a match requires exactly the modifiers the spec names', () => {
	expect(matchesShortcut('mod+Enter', keyEvent({ key: 'Enter', metaKey: true }), true)).toBe(true);
	expect(matchesShortcut('mod+Enter', keyEvent({ key: 'Enter', ctrlKey: true }), false)).toBe(true);
	// A held Shift is a different chord, not the same one with extra.
	expect(
		matchesShortcut('mod+Enter', keyEvent({ key: 'Enter', metaKey: true, shiftKey: true }), true),
	).toBe(false);
	// A single character compares case-insensitively; Shift is already checked.
	expect(matchesShortcut('mod+k', keyEvent({ key: 'K', metaKey: true }), true)).toBe(true);
});

test('only a field that takes typed characters suppresses a bare key', () => {
	expect(isEditableTarget(inputOfType('text'))).toBe(true);
	expect(isEditableTarget(inputOfType('password'))).toBe(true);
	expect(isEditableTarget(inputOfType('search'))).toBe(true);
	expect(isEditableTarget(document.createElement('textarea'))).toBe(true);

	// A checkbox or a radio consumes no characters, so a bare-letter shortcut
	// firing while one has focus interrupts nothing.
	expect(isEditableTarget(inputOfType('checkbox'))).toBe(false);
	expect(isEditableTarget(inputOfType('radio'))).toBe(false);
	expect(isEditableTarget(inputOfType('button'))).toBe(false);

	expect(isEditableTarget(document.createElement('div'))).toBe(false);
	expect(isEditableTarget(null)).toBe(false);
});

function keyEvent(over: {
	key: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
}) {
	return {
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...over,
	};
}

function inputOfType(type: string) {
	const el = document.createElement('input');
	el.type = type;
	return el;
}

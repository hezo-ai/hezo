import { describe, expect, test } from 'vitest';
import {
	ariaKeyshortcuts,
	formatShortcut,
	isEditableTarget,
	matchesShortcut,
	parseShortcut,
	shortcutBypassesInput,
} from '../src/lib/shortcuts';

describe('parseShortcut', () => {
	test('parses mod + key', () => {
		expect(parseShortcut('mod+Enter')).toEqual({
			mod: true,
			ctrl: false,
			meta: false,
			alt: false,
			shift: false,
			key: 'Enter',
		});
	});

	test('is case-insensitive on modifier tokens and tolerant of spaces', () => {
		expect(parseShortcut(' Mod + Shift + K ')).toMatchObject({ mod: true, shift: true, key: 'K' });
	});

	test('normalizes key aliases', () => {
		expect(parseShortcut('esc').key).toBe('Escape');
		expect(parseShortcut('mod+up').key).toBe('ArrowUp');
		expect(parseShortcut('return').key).toBe('Enter');
		expect(parseShortcut('del').key).toBe('Delete');
	});

	test('maps every modifier alias', () => {
		expect(parseShortcut('cmd+k')).toMatchObject({ meta: true });
		expect(parseShortcut('control+k')).toMatchObject({ ctrl: true });
		expect(parseShortcut('option+k')).toMatchObject({ alt: true });
	});
});

describe('shortcutBypassesInput', () => {
	test('true only for a non-Shift modifier; Shift-only and bare keys stay guarded', () => {
		expect(shortcutBypassesInput(parseShortcut('mod+Enter'))).toBe(true);
		expect(shortcutBypassesInput(parseShortcut('alt+k'))).toBe(true);
		// Shift alone does not bypass — shift+ArrowUp means "extend selection" in a field.
		expect(shortcutBypassesInput(parseShortcut('shift+ArrowUp'))).toBe(false);
		expect(shortcutBypassesInput(parseShortcut('r'))).toBe(false);
		expect(shortcutBypassesInput(parseShortcut('Escape'))).toBe(false);
	});
});

describe('formatShortcut', () => {
	test('mac uses tight symbol keycaps in canonical order', () => {
		expect(formatShortcut('mod+Enter', true)).toBe('⌘⏎');
		expect(formatShortcut('mod+Shift+k', true)).toBe('⇧⌘K');
		expect(formatShortcut('mod+k', true)).toBe('⌘K');
		expect(formatShortcut('Escape', true)).toBe('Esc');
	});

	test('non-mac uses Ctrl/Alt/Shift words joined with +', () => {
		expect(formatShortcut('mod+Enter', false)).toBe('Ctrl+⏎');
		expect(formatShortcut('mod+Shift+k', false)).toBe('Ctrl+Shift+K');
		expect(formatShortcut('Escape', false)).toBe('Esc');
	});

	test('renders arrow and delete glyphs', () => {
		expect(formatShortcut('mod+up', true)).toBe('⌘↑');
		expect(formatShortcut('Backspace', true)).toBe('⌫');
	});
});

describe('ariaKeyshortcuts', () => {
	test('resolves mod per platform to Meta / Control', () => {
		expect(ariaKeyshortcuts('mod+Enter', true)).toBe('Meta+Enter');
		expect(ariaKeyshortcuts('mod+Enter', false)).toBe('Control+Enter');
		expect(ariaKeyshortcuts('mod+Shift+k', false)).toBe('Control+Shift+K');
	});
});

describe('matchesShortcut', () => {
	const base = { key: 'Enter', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

	test('mod resolves to Meta on mac, Ctrl elsewhere', () => {
		expect(matchesShortcut('mod+Enter', { ...base, metaKey: true }, true)).toBe(true);
		expect(matchesShortcut('mod+Enter', { ...base, ctrlKey: true }, true)).toBe(false);
		expect(matchesShortcut('mod+Enter', { ...base, ctrlKey: true }, false)).toBe(true);
		expect(matchesShortcut('mod+Enter', { ...base, metaKey: true }, false)).toBe(false);
	});

	test('requires an exact modifier set (extra modifier does not match)', () => {
		expect(matchesShortcut('mod+Enter', { ...base, metaKey: true, shiftKey: true }, true)).toBe(
			false,
		);
	});

	test('single-char keys match case-insensitively', () => {
		expect(matchesShortcut('mod+k', { ...base, key: 'k', metaKey: true }, true)).toBe(true);
		expect(matchesShortcut('mod+k', { ...base, key: 'K', metaKey: true }, true)).toBe(true);
	});

	test('does not match a different key', () => {
		expect(matchesShortcut('Escape', { ...base, key: 'Enter' }, true)).toBe(false);
		expect(matchesShortcut('Escape', { ...base, key: 'Escape' }, true)).toBe(true);
	});
});

describe('isEditableTarget', () => {
	test('true for text-entry surfaces', () => {
		expect(isEditableTarget(document.createElement('input'))).toBe(true);
		expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
		expect(isEditableTarget(document.createElement('select'))).toBe(true);
		const editable = document.createElement('div');
		editable.setAttribute('role', 'textbox');
		expect(isEditableTarget(editable)).toBe(true);
	});

	test('false for a plain element or null', () => {
		expect(isEditableTarget(document.createElement('div'))).toBe(false);
		expect(isEditableTarget(null)).toBe(false);
	});
});

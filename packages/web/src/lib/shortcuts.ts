// Keyboard-shortcut parsing, platform-aware display, and event matching for the
// `shortcut` prop on <Button>. Kept pure (the only impurity, isMacPlatform, is
// isolated) so parse/format/match are unit-testable with an explicit `isMac`.
//
// Spec grammar: modifier tokens joined by `+`, then a key token, e.g.
//   "mod+Enter", "mod+k", "Escape", "mod+Shift+Enter", "shift+ArrowUp".
// `mod` is the platform-primary modifier — ⌘ (Meta) on macOS, Ctrl elsewhere.

export interface ParsedShortcut {
	/** Platform-primary modifier (Meta on mac, Ctrl elsewhere). */
	mod: boolean;
	ctrl: boolean;
	meta: boolean;
	alt: boolean;
	shift: boolean;
	/** Non-modifier key, normalized (e.g. "Enter", "Escape", "ArrowUp", "k"). */
	key: string;
}

const MODIFIER_TOKENS: Record<string, keyof Omit<ParsedShortcut, 'key'>> = {
	mod: 'mod',
	cmd: 'meta',
	command: 'meta',
	meta: 'meta',
	super: 'meta',
	win: 'meta',
	ctrl: 'ctrl',
	control: 'ctrl',
	alt: 'alt',
	opt: 'alt',
	option: 'alt',
	shift: 'shift',
};

// Normalize a key token to the canonical `KeyboardEvent.key` value we compare
// against. Single characters stay as-is (matched case-insensitively later).
const KEY_ALIASES: Record<string, string> = {
	enter: 'Enter',
	return: 'Enter',
	esc: 'Escape',
	escape: 'Escape',
	space: ' ',
	spacebar: ' ',
	tab: 'Tab',
	backspace: 'Backspace',
	del: 'Delete',
	delete: 'Delete',
	up: 'ArrowUp',
	down: 'ArrowDown',
	left: 'ArrowLeft',
	right: 'ArrowRight',
	arrowup: 'ArrowUp',
	arrowdown: 'ArrowDown',
	arrowleft: 'ArrowLeft',
	arrowright: 'ArrowRight',
};

function normalizeKey(token: string): string {
	const lower = token.toLowerCase();
	if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
	// Otherwise keep the raw token (single letters compared case-insensitively later).
	return token;
}

export function parseShortcut(spec: string): ParsedShortcut {
	const parsed: ParsedShortcut = {
		mod: false,
		ctrl: false,
		meta: false,
		alt: false,
		shift: false,
		key: '',
	};
	const tokens = spec
		.split('+')
		.map((t) => t.trim())
		.filter(Boolean);
	for (const token of tokens) {
		const mod = MODIFIER_TOKENS[token.toLowerCase()];
		if (mod) {
			parsed[mod] = true;
		} else {
			parsed.key = normalizeKey(token);
		}
	}
	return parsed;
}

/**
 * True when the shortcut is safe to fire even while a text field is focused —
 * i.e. it carries a non-Shift modifier (⌘/Ctrl/Alt). Shift is excluded on
 * purpose: `shift+ArrowUp` inside an input means "extend selection", so a
 * Shift-only spec is treated like a bare key and suppressed while typing.
 */
export function shortcutBypassesInput(parsed: ParsedShortcut): boolean {
	return parsed.mod || parsed.ctrl || parsed.meta || parsed.alt;
}

let cachedIsMac: boolean | undefined;

/** True on macOS / iPadOS, where `mod` renders as ⌘ and matches the Meta key. */
export function isMacPlatform(): boolean {
	if (cachedIsMac !== undefined) return cachedIsMac;
	if (typeof navigator === 'undefined') {
		cachedIsMac = false;
		return cachedIsMac;
	}
	const platform = navigator.platform || '';
	const ua = navigator.userAgent || '';
	cachedIsMac = /Mac|iPhone|iPad|iPod/i.test(platform) || /Mac OS X/i.test(ua);
	return cachedIsMac;
}

// Display glyphs. On mac we use the standard symbol keycaps; elsewhere modifiers
// read as words (Ctrl/Alt/Shift) while non-letter keys keep their universal glyph.
const KEY_GLYPHS: Record<string, string> = {
	Enter: '⏎',
	Escape: 'Esc',
	Backspace: '⌫',
	Delete: '⌦',
	ArrowUp: '↑',
	ArrowDown: '↓',
	ArrowLeft: '←',
	ArrowRight: '→',
	Tab: '⇥',
	' ': 'Space',
};

function displayKey(key: string): string {
	if (KEY_GLYPHS[key]) return KEY_GLYPHS[key];
	return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * Render a spec as a compact label for the keycap chip. macOS gets tight symbol
 * concatenation in canonical order (⌃⌥⇧⌘key); other platforms get `+`-joined
 * words (Ctrl+Shift+Enter → written with the key glyph, e.g. "Ctrl+⏎").
 */
export function formatShortcut(spec: string, isMac: boolean): string {
	const p = parseShortcut(spec);
	const key = displayKey(p.key);
	if (isMac) {
		const parts: string[] = [];
		if (p.ctrl) parts.push('⌃');
		if (p.alt) parts.push('⌥');
		if (p.shift) parts.push('⇧');
		if (p.meta || p.mod) parts.push('⌘');
		return parts.join('') + key;
	}
	const parts: string[] = [];
	if (p.mod || p.ctrl) parts.push('Ctrl');
	if (p.alt) parts.push('Alt');
	if (p.shift) parts.push('Shift');
	parts.push(key);
	return parts.join('+');
}

/** ARIA `aria-keyshortcuts` value (space-free, platform-independent tokens). */
export function ariaKeyshortcuts(spec: string, isMac: boolean): string {
	const p = parseShortcut(spec);
	const parts: string[] = [];
	if (p.meta || (p.mod && isMac)) parts.push('Meta');
	if (p.ctrl || (p.mod && !isMac)) parts.push('Control');
	if (p.alt) parts.push('Alt');
	if (p.shift) parts.push('Shift');
	parts.push(p.key.length === 1 ? p.key.toUpperCase() : p.key);
	return parts.join('+');
}

interface KeyEventLike {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

/** True when `event` satisfies every modifier + key requirement of `spec`. */
export function matchesShortcut(spec: string, event: KeyEventLike, isMac: boolean): boolean {
	const p = parseShortcut(spec);
	const wantMeta = p.meta || (p.mod && isMac);
	const wantCtrl = p.ctrl || (p.mod && !isMac);
	if (event.metaKey !== wantMeta) return false;
	if (event.ctrlKey !== wantCtrl) return false;
	if (event.altKey !== p.alt) return false;
	if (event.shiftKey !== p.shift) return false;
	// Single-char keys compare case-insensitively (Shift already checked above).
	if (p.key.length === 1) return event.key.toLowerCase() === p.key.toLowerCase();
	return event.key === p.key;
}

/**
 * True when the event target is a text-entry surface. Modifier-less shortcuts
 * (a bare letter) are suppressed here so typing never triggers a button.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
	if (target.isContentEditable) return true;
	return target.getAttribute('role') === 'textbox';
}

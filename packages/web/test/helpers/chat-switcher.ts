// Driving the chat dock's room switcher from a component test.
//
// It used to be a native <select>, so a test set `select.value` and read
// `select.options`. It is now a `SearchableSelect` popover: a trigger button, a
// type-to-filter box and option buttons that render in a **Radix portal** - so
// they live on `document.body`, not inside the render container. These helpers
// keep that one fact in one place.

import { waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

const TRIGGER = '[data-testid="chat-room-select-button"]';
const PANEL = '[data-testid="chat-room-select-content"]';
const OPTION = '[role="option"]';

/** The switcher's trigger button (inside the dock header), once it has mounted. */
export async function switcherTrigger(): Promise<HTMLElement> {
	return waitFor(() => {
		const el = document.body.querySelector<HTMLElement>(TRIGGER);
		if (!el) throw new Error('chat room switcher trigger not rendered');
		return el;
	});
}

/**
 * The room the dock is currently on, as the switcher's option value
 * (`ceo`, `agent:<slug>`, `group:<id>`, `thread:<id>`) - read off the header
 * title, so it needs no popover open.
 */
export function currentRoomValue(): string | undefined {
	return document.body.querySelector<HTMLElement>('[data-testid="chat-room-title"]')?.dataset.room;
}

/** Open the switcher panel and wait for its options to mount in the portal. */
export async function openRoomSwitcher(user: UserEvent): Promise<HTMLElement> {
	if (!document.body.querySelector(PANEL)) await user.click(await switcherTrigger());
	return waitFor(() => {
		const panel = document.body.querySelector<HTMLElement>(PANEL);
		if (!panel) throw new Error('switcher panel not open');
		return panel;
	});
}

/**
 * Visible option labels, in draw order, as `label · description` - the shape the
 * native <select> put in one <option>. Each line is its own element here, so
 * `textContent` would run them together; the unread dot's screen-reader text is
 * left out, since it is state rather than name.
 */
export function roomOptionLabels(): string[] {
	return [...document.body.querySelectorAll<HTMLElement>(OPTION)].map(optionLabel);
}

function optionLabel(el: HTMLElement): string {
	return [...el.querySelectorAll<HTMLElement>('span')]
		.filter((sp) => !sp.querySelector('span') && !sp.classList.contains('sr-only'))
		.map((sp) => (sp.textContent ?? '').replace(/\s+/g, ' ').trim())
		.filter(Boolean)
		.join(' · ');
}

/**
 * Option labels under one group heading - the rows a native <optgroup> used to
 * hold. Counts only that section, so an unrelated section growing cannot move
 * the assertion. Open the switcher first.
 */
export function roomOptionLabelsInGroup(heading: string): string[] {
	const panel = document.body.querySelector(PANEL);
	if (!panel) return [];
	const out: string[] = [];
	let inside = false;
	for (const el of panel.querySelectorAll<HTMLElement>(`${OPTION}, [aria-hidden="true"]`)) {
		if (el.matches(OPTION)) {
			if (inside) out.push(optionLabel(el));
			continue;
		}
		const text = (el.textContent ?? '').trim();
		if (!text || el.closest(OPTION)) continue;
		inside = text === heading;
	}
	return out;
}

/** Group headings currently drawn, in draw order. Open the switcher first. */
export function roomGroupHeadings(): string[] {
	const panel = document.body.querySelector(PANEL);
	return [...(panel?.querySelectorAll<HTMLElement>('[aria-hidden="true"]') ?? [])]
		.filter((el) => !el.closest(OPTION) && (el.textContent ?? '').trim().length > 0)
		.map((el) => (el.textContent ?? '').trim());
}

/** The checked option's label, i.e. the room the dock is on. */
export function selectedRoomLabel(): string | null {
	const el = document.body.querySelector<HTMLElement>(`${OPTION}[aria-selected="true"]`);
	return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : null;
}

/** Open the switcher and pick the room carrying `value` (e.g. `thread:thread-2`). */
export async function selectRoom(user: UserEvent, value: string): Promise<void> {
	await openRoomSwitcher(user);
	const option = document.body.querySelector<HTMLElement>(
		`[data-testid="chat-room-select-option-${value}"]`,
	);
	if (!option) {
		throw new Error(
			`no switcher option for "${value}"; options: ${roomOptionLabels().join(' | ')}`,
		);
	}
	await user.click(option);
}

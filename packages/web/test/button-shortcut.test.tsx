import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { Button } from '../src/components/ui/button';

// Standalone leaf-component test — no app context needed. Verifies the keycap
// chip renders and that the guarded document-level auto-fire clicks the button.
// Platform-independent specs only (Escape, a bare letter) so it never branches
// on the CI host being mac vs linux.

describe('Button shortcut chip', () => {
	test('renders the keycap and sets aria-keyshortcuts', () => {
		render(<Button shortcut="mod+Enter">Create</Button>);
		const btn = screen.getByRole('button', { name: /Create/ });
		// The Enter glyph is the same on every platform.
		const kbd = btn.querySelector('kbd');
		expect(kbd?.textContent).toContain('⏎');
		expect(btn.getAttribute('aria-keyshortcuts')).toMatch(/^(Meta|Control)\+Enter$/);
	});

	test('no chip and no aria when shortcut is absent', () => {
		render(<Button>Plain</Button>);
		const btn = screen.getByRole('button', { name: 'Plain' });
		expect(btn.querySelector('kbd')).toBeNull();
		expect(btn.getAttribute('aria-keyshortcuts')).toBeNull();
	});

	test('auto-fires onClick when the shortcut is pressed', () => {
		const onClick = vi.fn();
		render(
			<Button shortcut="Escape" onClick={onClick}>
				Close
			</Button>,
		);
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	test('a modifier-less shortcut is suppressed while a text field is focused', () => {
		const onClick = vi.fn();
		render(
			<>
				<input aria-label="field" />
				<Button shortcut="r" onClick={onClick}>
					Reply
				</Button>
			</>,
		);
		const input = screen.getByLabelText('field');
		// Fired from within the input → suppressed.
		fireEvent.keyDown(input, { key: 'r' });
		expect(onClick).not.toHaveBeenCalled();
		// Fired from outside any field → allowed.
		fireEvent.keyDown(document.body, { key: 'r' });
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	test('a disabled button does not fire its shortcut', () => {
		const onClick = vi.fn();
		render(
			<Button shortcut="Escape" onClick={onClick} disabled>
				Close
			</Button>,
		);
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClick).not.toHaveBeenCalled();
	});

	test('shortcutFire={false} shows the chip but does not auto-fire', () => {
		const onClick = vi.fn();
		render(
			<Button shortcut="mod+k" shortcutFire={false} onClick={onClick}>
				Search
			</Button>,
		);
		expect(screen.getByRole('button', { name: /Search/ }).querySelector('kbd')).not.toBeNull();
		fireEvent.keyDown(document, { key: 'k', metaKey: true });
		fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
		expect(onClick).not.toHaveBeenCalled();
	});

	test('does not fire when another handler already prevented the event', () => {
		const onClick = vi.fn();
		render(
			<Button shortcut="Escape" onClick={onClick}>
				Close
			</Button>,
		);
		const evt = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
		evt.preventDefault();
		document.dispatchEvent(evt);
		expect(onClick).not.toHaveBeenCalled();
	});
});

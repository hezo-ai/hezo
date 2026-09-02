import { Button, HelpDialog } from '@hezo/ui';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { expect, test } from 'vitest';

// A wrapper spreading its own props onto `Button` used to smuggle a ref past
// the internal one the shortcut binding clicks through. It type-checked, the
// keycap still rendered, and the key did nothing.
test('a caller ref reaches the element without displacing the shortcut binding', () => {
	const ref = createRef<HTMLButtonElement>();
	const clicks: string[] = [];

	render(
		<Button ref={ref} shortcut="mod+k" onClick={() => clicks.push('clicked')}>
			Search
		</Button>,
	);

	expect(ref.current).toBe(screen.getByRole('button', { name: /Search/ }));

	document.dispatchEvent(
		new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }),
	);
	document.dispatchEvent(
		new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }),
	);

	expect(clicks.length).toBeGreaterThan(0);
});

// A component that opens a dialog forwards the close button's name. Without
// that the body falls back to English on a surface whose every other string is
// translated, and no consumer can reach it.
test('the help dialog forwards the close label it is given', async () => {
	render(
		<HelpDialog title="Pricing" triggerLabel="Help" closeLabel="Sluiten">
			<p>How pricing works.</p>
		</HelpDialog>,
	);

	screen.getByRole('button', { name: 'Help' }).click();

	expect((await screen.findByTestId('dialog-close')).getAttribute('aria-label')).toBe('Sluiten');
});

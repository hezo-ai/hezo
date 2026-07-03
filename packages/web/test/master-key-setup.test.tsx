import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { MasterKeyForm } from '../src/components/master-key-gate';

afterEach(() => {
	cleanup();
	// Remove any clipboard stub so it doesn't leak to other specs in the worker.
	Reflect.deleteProperty(navigator, 'clipboard');
});

test('setup generates a 12-word master key in a numbered grid', async () => {
	render(<MasterKeyForm state="unset" embedded />);

	fireEvent.click(screen.getByRole('button', { name: /generate master key/i }));

	const words = await screen.findAllByTestId('mnemonic-word');
	expect(words).toHaveLength(12);
	for (let i = 0; i < words.length; i++) {
		expect(words[i].textContent).toContain(String(i + 1));
	}
	// Copy affordance is present once the phrase is shown.
	expect(screen.getByRole('button', { name: /copy to clipboard/i })).toBeTruthy();
});

test('copy writes the space-joined phrase and toggles the label', async () => {
	const calls: string[] = [];
	Object.defineProperty(navigator, 'clipboard', {
		value: {
			writeText: (text: string) => {
				calls.push(text);
				return Promise.resolve();
			},
		},
		configurable: true,
		writable: true,
	});

	render(<MasterKeyForm state="unset" embedded />);
	fireEvent.click(screen.getByRole('button', { name: /generate master key/i }));
	await screen.findAllByTestId('mnemonic-word');
	fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));

	expect(calls).toHaveLength(1);
	expect(calls[0].split(' ')).toHaveLength(12);
	await screen.findByText('Copied!');
});

test('unlock rejects an invalid phrase inline without authenticating', async () => {
	render(<MasterKeyForm state="locked" embedded />);

	fireEvent.change(screen.getByLabelText(/master key/i), {
		target: { value: 'not a valid phrase at all here please thanks' },
	});
	fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

	await screen.findByText(/not a valid 12-word master key/i);
});

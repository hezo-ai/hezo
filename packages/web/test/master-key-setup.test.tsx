import { generateMnemonic } from '@hezo/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { MasterKeyForm } from '../src/components/master-key-gate';
import { withI18n } from './helpers/i18n';

// Mirror the timing constants in master-key-gate.tsx.
const SAVE_COUNTDOWN_SECONDS = 5;
const REGEN_ANIM_MS = 1200;

/** Reveal the grid, then read the 12 words back (strip the leading position number). */
function revealedPhrase(): string {
	fireEvent.click(screen.getByRole('button', { name: /^show key$/i }));
	return screen
		.getAllByTestId('mnemonic-word')
		.map((w) => (w.textContent ?? '').replace(/^\d+/, ''))
		.join(' ');
}

/**
 * Copy the generated key, run out the save countdown, and click Continue to reach
 * the confirm step. Requires fake timers (the countdown ticks via chained 1s
 * timeouts, flushed one render at a time).
 */
async function copyAndContinue(): Promise<void> {
	fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));
	// Resolve the async clipboard write so Continue replaces the copy button.
	await act(async () => {});
	for (let i = 0; i <= SAVE_COUNTDOWN_SECONDS; i++) {
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
	}
	fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	// Remove any clipboard stub so it doesn't leak to other specs in the worker.
	Reflect.deleteProperty(navigator, 'clipboard');
});

test('setup generates a 12-word master key in a numbered grid', async () => {
	render(withI18n(<MasterKeyForm state="unset" embedded />));

	fireEvent.click(screen.getByRole('button', { name: /generate master key/i }));

	const words = await screen.findAllByTestId('mnemonic-word');
	expect(words).toHaveLength(12);
	for (let i = 0; i < words.length; i++) {
		expect(words[i].textContent).toContain(String(i + 1));
	}
	// Copy affordance is present once the phrase is shown; Continue is gated on it.
	expect(screen.getByRole('button', { name: /copy to clipboard/i })).toBeTruthy();
	expect(screen.queryByRole('button', { name: /continue/i })).toBeNull();
});

test('the generated-key warning states the complete restart lifecycle', async () => {
	render(withI18n(<MasterKeyForm state="unset" embedded />));

	fireEvent.click(screen.getByRole('button', { name: /generate master key/i }));

	expect(await screen.findByText('Encrypts your data and unlocks Hezo.')).toBeTruthy();
	expect(
		screen.getByText(
			/New processes start locked by default.*in-app update.*key forward in memory.*reboot, crash, or direct service restart.*one-shot --master-key or HEZO_MASTER_KEY input/i,
		),
	).toBeTruthy();
});

test('copy writes the space-joined phrase and reveals Continue', async () => {
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

	render(withI18n(<MasterKeyForm state="unset" embedded />));
	fireEvent.click(screen.getByRole('button', { name: /generate master key/i }));
	await screen.findAllByTestId('mnemonic-word');
	fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));

	expect(calls).toHaveLength(1);
	expect(calls[0].split(' ')).toHaveLength(12);
	// Copying swaps the copy button out for Continue (initially disabled by the countdown).
	const cont = (await screen.findByRole('button', { name: /continue/i })) as HTMLButtonElement;
	expect(cont.disabled).toBe(true);
	expect(screen.queryByRole('button', { name: /copy to clipboard/i })).toBeNull();
});

test('unlock rejects an invalid phrase inline without authenticating', async () => {
	render(withI18n(<MasterKeyForm state="locked" embedded />));

	fireEvent.change(screen.getByLabelText(/master key/i), {
		target: { value: 'not a valid phrase at all here please thanks' },
	});
	fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

	await screen.findByText(/not a valid 12-word master key/i);
});

test('generated words are masked (password-style) by default', async () => {
	render(withI18n(<MasterKeyForm state="unset" embedded />));
	fireEvent.click(screen.getByRole('button', { name: /generate master key/i }));

	const words = await screen.findAllByTestId('mnemonic-word');
	expect(words).toHaveLength(12);
	// Each chip shows its position number plus a dot mask — never the word.
	for (const w of words) {
		expect(w.textContent).toContain('•');
	}
});

test('the eye toggle reveals and re-hides the words', async () => {
	render(withI18n(<MasterKeyForm state="unset" embedded />));
	fireEvent.click(screen.getByRole('button', { name: /generate master key/i }));
	await screen.findAllByTestId('mnemonic-word');

	// Reveal → 12 real alpha words, no dots.
	fireEvent.click(screen.getByRole('button', { name: /^show key$/i }));
	const revealed = screen
		.getAllByTestId('mnemonic-word')
		.map((w) => (w.textContent ?? '').replace(/^\d+/, ''));
	expect(revealed).toHaveLength(12);
	expect(revealed.every((t) => /^[a-z]+$/.test(t))).toBe(true);

	// Hide → masked again.
	fireEvent.click(screen.getByRole('button', { name: /^hide key$/i }));
	expect(
		screen.getAllByTestId('mnemonic-word').every((w) => (w.textContent ?? '').includes('•')),
	).toBe(true);
});

test('the confirm step shows a masked entry field with a toggle', async () => {
	vi.useFakeTimers();
	render(withI18n(<MasterKeyForm state="unset" embedded />));
	fireEvent.click(screen.getByRole('button', { name: /generate master key/i }));
	screen.getAllByTestId('mnemonic-word');
	await copyAndContinue();

	const field = screen.getByLabelText(/master key/i) as HTMLInputElement;
	expect(field.type).toBe('password');
	expect(screen.getByRole('button', { name: /^show key$/i })).toBeTruthy();
});

test('the confirm step rejects a phrase that does not match the generated key', async () => {
	vi.useFakeTimers();
	render(withI18n(<MasterKeyForm state="unset" embedded />));
	fireEvent.click(screen.getByRole('button', { name: /generate master key/i }));
	screen.getAllByTestId('mnemonic-word');
	await copyAndContinue();

	// A different valid phrase must not satisfy the paste-back check (no network hit).
	fireEvent.change(screen.getByLabelText(/master key/i), {
		target: { value: generateMnemonic() },
	});
	fireEvent.click(screen.getByRole('button', { name: /confirm key and continue/i }));
	await act(async () => {});

	expect(screen.getByText(/doesn't match your master key/i)).toBeTruthy();
});

test('Back returns from confirm to the generated key', async () => {
	vi.useFakeTimers();
	render(withI18n(<MasterKeyForm state="unset" embedded />));
	fireEvent.click(screen.getByRole('button', { name: /generate master key/i }));
	screen.getAllByTestId('mnemonic-word');
	await copyAndContinue();
	expect(screen.getByLabelText(/master key/i)).toBeTruthy();

	fireEvent.click(screen.getByRole('button', { name: /^back$/i }));

	expect(screen.getAllByTestId('mnemonic-word')).toHaveLength(12);
	// Already copied earlier, so the save gate stays open — Continue is available again.
	expect(screen.getByRole('button', { name: /^continue$/i })).toBeTruthy();
});

test('the refresh control replaces the phrase and re-masks it', async () => {
	vi.useFakeTimers();
	render(withI18n(<MasterKeyForm state="unset" embedded />));
	fireEvent.click(screen.getByRole('button', { name: /generate master key/i }));
	screen.getAllByTestId('mnemonic-word');
	const first = revealedPhrase();

	fireEvent.click(screen.getByRole('button', { name: /generate a new key/i }));
	// The words shimmer as placeholders, then the fresh phrase swaps in after the animation.
	await act(async () => {
		vi.advanceTimersByTime(REGEN_ANIM_MS);
	});

	const words = screen.getAllByTestId('mnemonic-word');
	expect(words).toHaveLength(12);
	// Re-masked after regenerating.
	expect(words.every((w) => (w.textContent ?? '').includes('•'))).toBe(true);
	// A fresh phrase, distinct from the first.
	expect(revealedPhrase()).not.toBe(first);
});

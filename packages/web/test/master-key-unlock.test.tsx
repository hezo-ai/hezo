import { generateMnemonic } from '@hezo/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { MasterKeyForm } from '../src/components/master-key-gate';
import { api } from '../src/lib/api';
// Importing the harness registers its beforeEach: an in-process Hono + PGlite
// backend (enrolled and unlocked) with fetch rerouted to it. The form is
// rendered with state="locked", so the client runs the unlock flow — derive
// keys in the browser, sign the challenge, send the unlock key — which the
// server accepts even while already unlocked (stale-locked-client tolerance).
import { getTestContext } from './helpers/render';

afterEach(cleanup);

test('unlock derives keys client-side and completes the challenge dance', async () => {
	const ctx = getTestContext();
	api.clearToken();

	render(<MasterKeyForm state="locked" embedded />);
	fireEvent.change(screen.getByLabelText(/master key/i), {
		target: { value: ctx.mnemonic },
	});
	fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

	await waitFor(() => {
		expect(api.getToken()).toBeTruthy();
	});
	expect(screen.queryByText(/failed|invalid/i)).toBeNull();
});

test('a wrong-but-valid phrase shows the server rejection inline', async () => {
	render(<MasterKeyForm state="locked" embedded />);
	fireEvent.change(screen.getByLabelText(/master key/i), {
		target: { value: generateMnemonic() },
	});
	fireEvent.click(screen.getByRole('button', { name: /unlock/i }));

	// The signature comes from the wrong keypair, so the server rejects it.
	await screen.findByText(/signature verification failed/i);
});

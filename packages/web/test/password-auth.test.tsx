import { api } from '@hezo/web/lib/api';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

// The gate reads `/api/status.passwordSet` + a `/api/me` session probe:
//  - unlocked + passwordSet + no session → password login
//  - unlocked + !passwordSet + a credential → create-password wizard step
// The harness seeds a verifier + session, so we mutate one of those per test.

test('shows the password login with no session and signs in with the password', async () => {
	const { findByTestId, getByLabelText, user, queryByTestId } = await renderApp({
		initialPath: '/',
		seed: async () => {
			// Fresh browser: a password exists on the server, but this client has no
			// session token.
			api.clearToken();
			localStorage.removeItem('hezo_token');
		},
	});

	await findByTestId('password-login');

	const ctx = getTestContext();
	await user.type(getByLabelText('Password'), ctx.password);
	await user.click(
		await findByTestId('password-login').then(
			(el) => el.querySelector('button[type="submit"]') as HTMLButtonElement,
		),
	);

	// A correct password mints a session; the gate advances off the login screen.
	await expect.poll(() => queryByTestId('password-login')).toBeNull();
});

test('the login password field has a show/hide toggle', async () => {
	const { findByTestId, getByLabelText, getByRole, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			api.clearToken();
			localStorage.removeItem('hezo_token');
		},
	});

	await findByTestId('password-login');
	const input = getByLabelText('Password') as HTMLInputElement;
	expect(input.type).toBe('password');

	await user.click(getByRole('button', { name: 'Show password' }));
	expect(input.type).toBe('text');

	await user.click(getByRole('button', { name: 'Hide password' }));
	expect(input.type).toBe('password');
});

test('offers master-key recovery from the login screen', async () => {
	const { findByTestId, findByText } = await renderApp({
		initialPath: '/',
		seed: async () => {
			api.clearToken();
			localStorage.removeItem('hezo_token');
		},
	});

	const login = await findByTestId('password-login');
	// The forgot-password affordance points at the master key.
	const forgot = await findByText(/forgot password\?/i);
	forgot.click();
	await findByTestId('forgot-password-master-key');
	expect(login).toBeDefined();
});

test('with no session and no password, master-key re-entry leads to create-password', async () => {
	const { findByTestId, findByText, getByLabelText, user, queryByTestId } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			// No session, and no password verifier yet (e.g. a page refresh mid-onboarding
			// lost the in-memory setup token). The gate asks for the master key first.
			api.clearToken();
			localStorage.removeItem('hezo_token');
			await ctx.db.query(
				`UPDATE users SET password_salt = NULL, password_public_key = NULL WHERE is_superuser = true`,
			);
		},
	});

	// Re-enter the master key to obtain a password-setup token.
	await findByText(/confirm your master key/i);
	const ctx = getTestContext();
	await user.type(getByLabelText('Master Key'), ctx.mnemonic);
	await user.click(await findByText('Unlock'));

	// Then the create-password step, which mints the first session.
	await findByTestId('setup-step-password');
	await user.type(getByLabelText('Password'), 'a-new-strong-password');
	await user.type(getByLabelText('Confirm password'), 'a-new-strong-password');
	const step = await findByTestId('setup-step-password');
	await user.click(step.querySelector('button[type="submit"]') as HTMLButtonElement);

	await expect.poll(() => queryByTestId('setup-step-password')).toBeNull();
});

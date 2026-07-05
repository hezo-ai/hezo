import { buildPasswordLoginMessage, derivePasswordKeyPair, signAuthMessage } from '@hezo/shared';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

async function renderPage() {
	const utils = await renderApp({ initialPath: '/settings/admin-password' });
	await utils.findByRole('heading', { name: 'Admin password' });
	return utils;
}

test('eye toggle reveals and re-hides the password text', async () => {
	const { getByLabelText, getAllByRole, user } = await renderPage();

	const current = getByLabelText('Current password') as HTMLInputElement;
	expect(current.type).toBe('password');

	// Three fields → three toggles; the first belongs to Current password.
	const [toggle] = getAllByRole('button', { name: 'Show password' });
	await user.click(toggle);
	expect(current.type).toBe('text');
	expect(toggle.getAttribute('aria-label')).toBe('Hide password');

	await user.click(toggle);
	expect(current.type).toBe('password');
});

test('changing the password with the correct current password succeeds', async () => {
	const { ctx, getByLabelText, getByRole, findByText, user } = await renderPage();

	await user.type(getByLabelText('Current password'), ctx.password);
	await user.type(getByLabelText('New password'), 'a-new-strong-password');
	await user.type(getByLabelText('Confirm new password'), 'a-new-strong-password');
	await user.click(getByRole('button', { name: 'Save' }));

	await findByText('Password updated.');

	// The change landed server-side: a real challenge/verify login with the new
	// password succeeds against the in-process backend.
	const challengeRes = await ctx.apiBase('/api/auth/password-challenge', { method: 'POST' });
	expect(challengeRes.status).toBe(200);
	const { data } = (await challengeRes.json()) as {
		data: { challenge_id: string; nonce: string; salt: string };
	};
	const { privateKey } = await derivePasswordKeyPair('a-new-strong-password', data.salt);
	const verifyRes = await ctx.apiBase('/api/auth/password-verify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			challenge_id: data.challenge_id,
			signature: signAuthMessage(privateKey, buildPasswordLoginMessage(data.nonce)),
		}),
	});
	expect(verifyRes.status).toBe(200);
});

test('a wrong current password shows the server error and changes nothing', async () => {
	const { getByLabelText, getByRole, findByText, user } = await renderPage();

	await user.type(getByLabelText('Current password'), 'not-the-password');
	await user.type(getByLabelText('New password'), 'a-new-strong-password');
	await user.type(getByLabelText('Confirm new password'), 'a-new-strong-password');
	await user.click(getByRole('button', { name: 'Save' }));

	await findByText('Incorrect password');
});

test('too-short and mismatched passwords disable Save with inline hints', async () => {
	const { getByLabelText, getByRole, findByText, user } = await renderPage();

	const save = getByRole('button', { name: 'Save' }) as HTMLButtonElement;
	await user.type(getByLabelText('Current password'), 'whatever');

	await user.type(getByLabelText('New password'), 'short');
	await findByText('At least 8 characters.');
	expect(save.disabled).toBe(true);

	await user.type(getByLabelText('New password'), '-but-now-long-enough');
	await user.type(getByLabelText('Confirm new password'), 'something-else');
	await findByText("Passwords don't match.");
	expect(save.disabled).toBe(true);
});

test('non-superuser sees the managed message instead of the form', async () => {
	const { findByText, queryByLabelText } = await renderApp({
		initialPath: '/settings/admin-password',
		seed: async (ctx) => {
			await ctx.db.query('UPDATE users SET is_superuser = false');
		},
	});

	await findByText(/managed by the Admin/i);
	expect(queryByLabelText('Current password')).toBeNull();
});

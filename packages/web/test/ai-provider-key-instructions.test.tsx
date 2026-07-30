import { waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// Every provider offered by the Add-provider picker, with the key-console URL
// its instructions box must link to. Mirrors ADD_PROVIDER_ORDER; the URLs are
// each provider's own documented key-management page.
const EXPECTED_KEY_LINKS: ReadonlyArray<{ card: string; title: RegExp; href: string }> = [
	{
		card: 'DeepSeek',
		title: /How to get your DeepSeek API key/i,
		href: 'https://platform.deepseek.com/api_keys',
	},
	{
		card: 'z.ai',
		title: /How to get your Z\.ai API key/i,
		href: 'https://z.ai/manage-apikey/apikey-list',
	},
	{
		card: 'Anthropic',
		title: /How to get your Anthropic API key/i,
		href: 'https://platform.claude.com/settings/keys',
	},
	{
		card: 'OpenAI',
		title: /How to get your OpenAI API key/i,
		href: 'https://platform.openai.com/api-keys',
	},
	{
		card: 'Google',
		title: /How to get your Gemini API key/i,
		href: 'https://aistudio.google.com/apikey',
	},
	{
		card: 'Kimi',
		title: /How to get your Kimi API key/i,
		href: 'https://platform.kimi.ai/console/api-keys',
	},
	{
		// Kimi Code is the same Moonshot account and the same key as Kimi above, so
		// it shares one instructions block. Asserting both cards reach it is what
		// keeps that sharing honest.
		card: 'Kimi Code',
		title: /How to get your Kimi API key/i,
		href: 'https://platform.kimi.ai/console/api-keys',
	},
];

test('every pickable provider shows how-to-get-a-key instructions linking its key console', async () => {
	const { findByRole, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	await findByRole('heading', { name: 'AI providers' });
	await user.click(getByRole('button', { name: 'Add provider' }));
	const dialog = await findByRole('dialog');

	for (const { card, title, href } of EXPECTED_KEY_LINKS) {
		await user.click(within(dialog).getByRole('button', { name: card }));

		// The API-key mode is the default, so the instructions box renders
		// immediately with a link to the provider's own key console.
		await within(dialog).findByText(title);
		await waitFor(() => {
			const link = Array.from(dialog.querySelectorAll('a')).find(
				(a) => a.getAttribute('href') === href,
			);
			if (!link) throw new Error(`No link to ${href} for ${card}`);
			// Console links open in a new tab so the in-progress form isn't lost.
			expect(link.getAttribute('target')).toBe('_blank');
		});

		// Back to the picker grid for the next provider.
		await user.click(within(dialog).getByRole('button', { name: 'Back' }));
		await within(dialog).findByRole('button', { name: card });
	}
});

test('switching Anthropic to subscription swaps the API-key instructions for the setup-token ones', async () => {
	const { findByRole, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	await findByRole('heading', { name: 'AI providers' });
	await user.click(getByRole('button', { name: 'Add provider' }));
	const dialog = await findByRole('dialog');

	await user.click(within(dialog).getByRole('button', { name: 'Anthropic' }));
	await within(dialog).findByText(/How to get your Anthropic API key/i);

	await user.click(within(dialog).getByRole('button', { name: /Claude Code subscription/i }));
	await within(dialog).findByText(/How to get your Claude subscription token/i);
	expect(within(dialog).queryByText(/How to get your Anthropic API key/i)).toBeNull();

	// And back: API-key mode restores the key instructions.
	await user.click(within(dialog).getByRole('button', { name: 'API key' }));
	await within(dialog).findByText(/How to get your Anthropic API key/i);
	expect(within(dialog).queryByText(/How to get your Claude subscription token/i)).toBeNull();
});

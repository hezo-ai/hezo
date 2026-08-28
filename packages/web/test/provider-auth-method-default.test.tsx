import { AiProvider } from '@hezo/shared';
import { within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

interface ProviderListResponse {
	data: Array<{ id: string; label: string; auth_method: string }>;
}

/**
 * Which auth method the provider form opens on, and in what order it offers the
 * two.
 *
 * A provider that has a subscription opens on it: that is the credential the
 * operator already owns and the one Hezo can mint end to end, so it leads and an
 * API key is the deliberate second choice. A provider without one is unchanged -
 * it has no pill row at all. Editing never guesses: it opens on whatever the
 * stored config actually uses.
 */

/**
 * Remove the harness's seeded credential so the setup gate renders its provider
 * card grid - the same shortcut the other ai-provider specs use to reach the
 * credential form without going through the settings modal.
 */
async function clearAiProviders() {
	const { apiBase, token } = getTestContext();
	const headers = { Authorization: `Bearer ${token}` };
	const listRes = await apiBase('/api/ai-providers', { headers });
	const { data } = (await listRes.json()) as ProviderListResponse;
	for (const config of data) {
		await apiBase(`/api/ai-providers/${config.id}`, { method: 'DELETE', headers });
	}
}

async function postProvider(body: Record<string, unknown>) {
	const { apiBase, token } = getTestContext();
	return apiBase('/api/ai-providers', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

test('a provider with a subscription opens on it, offered before the API key', async () => {
	const { container, findByRole, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: clearAiProviders,
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });
	await user.click(getByRole('button', { name: 'Anthropic' }));

	const subscription = await findByRole('button', { name: /Claude Code subscription/i });
	const apiKey = getByRole('button', { name: 'API key' });

	// Selected without the operator choosing it.
	expect(subscription.getAttribute('aria-pressed')).toBe('true');
	expect(apiKey.getAttribute('aria-pressed')).toBe('false');

	// And offered first. DOCUMENT_POSITION_FOLLOWING means the API key pill comes
	// after the subscription one, which is the whole ordering claim.
	expect(
		subscription.compareDocumentPosition(apiKey) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();

	// The form body follows the pill, so the key field is not on the default path.
	await findByRole('button', { name: /Sign in with Claude Code/i });
	expect(container.querySelector('input[type="password"]')).toBeNull();
});

test('choosing the API key pill switches the form and the pressed state', async () => {
	const { container, findByRole, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: clearAiProviders,
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });
	await user.click(getByRole('button', { name: 'Anthropic' }));
	await user.click(getByRole('button', { name: 'API key' }));

	expect(getByRole('button', { name: 'API key' }).getAttribute('aria-pressed')).toBe('true');
	expect(
		getByRole('button', { name: /Claude Code subscription/i }).getAttribute('aria-pressed'),
	).toBe('false');
	expect(container.querySelector('input[type="password"]')).not.toBeNull();
});

test('a provider with no subscription still opens on its API key, with no pill row', async () => {
	const { container, findByRole, getByRole, queryByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: clearAiProviders,
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });
	await user.click(getByRole('button', { name: 'DeepSeek' }));

	// DeepSeek is api-key only, so there is nothing to choose between and the key
	// field is the arrival state.
	expect(queryByRole('button', { name: /subscription/i })).toBeNull();
	expect(queryByRole('button', { name: 'API key' })).toBeNull();
	expect(container.querySelector('input[type="password"]')).not.toBeNull();
});

test('editing an API-key config opens on API key, not on the subscription', async () => {
	const { findByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
			await postProvider({
				provider: AiProvider.Anthropic,
				api_key: 'sk-ant-stored-key-component',
				auth_method: 'api_key',
				label: 'Anthropic',
			});
		},
	});

	await findByRole('heading', { name: 'AI providers' }, { timeout: 15_000 });
	await user.click(await findByRole('button', { name: 'Edit Anthropic' }, { timeout: 15_000 }));

	// The stored method wins over the add-flow default - flipping it would offer
	// to replace a credential the operator never said to replace.
	const dialog = await findByRole('dialog');
	expect(within(dialog).getByRole('button', { name: 'API key' }).getAttribute('aria-pressed')).toBe(
		'true',
	);
	expect(
		within(dialog)
			.getByRole('button', { name: /Claude Code subscription/i })
			.getAttribute('aria-pressed'),
	).toBe('false');
});

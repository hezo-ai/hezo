import { DEFAULT_TEAM_SLUG } from '@hezo/shared';
import { queryClient as singletonQueryClient } from '@hezo/web/lib/query-client';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

interface ProviderListResponse {
	data: Array<{ id: string }>;
}

async function clearAiProviders() {
	const { apiBase, token } = getTestContext();
	const headers = { Authorization: `Bearer ${token}` };
	const listRes = await apiBase('/api/ai-providers', { headers });
	const { data } = (await listRes.json()) as ProviderListResponse;
	for (const config of data) {
		await apiBase(`/api/ai-providers/${config.id}`, {
			method: 'DELETE',
			headers,
		});
	}
}

async function postProvider(body: Record<string, unknown>) {
	const { apiBase, token } = getTestContext();
	return apiBase('/api/ai-providers', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	});
}

test('lists Anthropic / OpenAI / Google on /settings/ai-providers (no Moonshot, no OAuth)', async () => {
	const { findByRole, findByText, queryAllByText, queryAllByRole } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	await findByRole('heading', { name: 'AI providers' });
	await findByText('Anthropic');
	await findByText('OpenAI');
	await findByText('Google');
	expect(queryAllByText('Moonshot').length).toBe(0);
	expect(queryAllByRole('button', { name: /OAuth/i }).length).toBe(0);
});

test('sidebar Settings link navigates to /settings and renders the AI providers section', async () => {
	const { findByRole, findByText, getAllByRole, router, user } = await renderApp({
		initialPath: `/teams/${DEFAULT_TEAM_SLUG}/tasks`,
	});

	const settingsLinks = await waitFor(
		() => {
			const links = getAllByRole('link', { name: 'Settings' });
			const global = links.find((l) => l.getAttribute('href') === '/settings');
			if (!global) throw new Error('Settings link not found yet');
			return global;
		},
		{ timeout: 15_000 },
	);

	await user.click(settingsLinks);
	await waitFor(() => expect(router.state.location.pathname).toBe('/settings'), {
		timeout: 10_000,
	});
	await findByRole('heading', { name: 'Settings' });
	await findByRole('heading', { name: 'AI providers' });
	await findByText('Anthropic');
});

test('can add an Anthropic API key via the settings UI', async () => {
	const { container, findByRole, findByText, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			// Clear the default seeded provider so the gate modal renders and the
			// "Enter API key" affordance is reachable.
			await clearAiProviders();
		},
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });

	// Find the Anthropic card inside the gate modal (p-4 padding).
	const modalCards = Array.from(
		container.querySelectorAll<HTMLElement>('div.border.border-border.rounded-radius-md.p-4'),
	);
	const anthropicCard = modalCards.find((el) => el.textContent?.includes('Anthropic'));
	expect(anthropicCard).toBeTruthy();

	await user.click(within(anthropicCard!).getByRole('button', { name: 'Enter API key' }));
	const keyInput = anthropicCard!.querySelector('input[type="password"]') as HTMLInputElement;
	fireEvent.change(keyInput, { target: { value: 'sk-ant-component-test-1234567890' } });
	await user.click(within(anthropicCard!).getByRole('button', { name: 'Save' }));

	// Once a provider is configured the gate drops and the settings page renders.
	await findByText('active', undefined, { timeout: 15_000 });
});

test('does not offer subscription auth for Anthropic', async () => {
	const { container, findByRole } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
		},
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });

	const modalCards = Array.from(
		container.querySelectorAll<HTMLElement>('div.border.border-border.rounded-radius-md.p-4'),
	);
	const anthropicCard = modalCards.find((el) => el.textContent?.includes('Anthropic'));
	expect(anthropicCard).toBeTruthy();

	expect(within(anthropicCard!).queryByRole('button', { name: /Enter API key/i })).toBeTruthy();
	expect(
		within(anthropicCard!).queryByRole('button', { name: /Use Claude Code subscription/i }),
	).toBeNull();
});

test('offers Codex subscription paste flow for OpenAI', async () => {
	const { container, findByRole, findByText, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
		},
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });

	const modalCards = Array.from(
		container.querySelectorAll<HTMLElement>('div.border.border-border.rounded-radius-md.p-4'),
	);
	const openaiCard = modalCards.find((el) => el.textContent?.includes('OpenAI'));
	expect(openaiCard).toBeTruthy();

	await user.click(within(openaiCard!).getByRole('button', { name: /Use Codex subscription/i }));
	const codexHits = await within(openaiCard!).findAllByText(/codex login/i);
	expect(codexHits.length).toBeGreaterThan(0);
	const textarea = openaiCard!.querySelector('textarea') as HTMLTextAreaElement;
	fireEvent.change(textarea, {
		target: { value: JSON.stringify({ tokens: { refresh_token: 'rt-component-paste' } }) },
	});
	await user.click(within(openaiCard!).getByRole('button', { name: 'Save' }));

	await findByText('Subscription', undefined, { timeout: 15_000 });
});

test('offers Gemini subscription paste flow for Google', async () => {
	const { container, findByRole, findByText, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
		},
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });

	const modalCards = Array.from(
		container.querySelectorAll<HTMLElement>('div.border.border-border.rounded-radius-md.p-4'),
	);
	const googleCard = modalCards.find((el) => el.textContent?.includes('Google'));
	expect(googleCard).toBeTruthy();

	await user.click(within(googleCard!).getByRole('button', { name: /Use Gemini subscription/i }));
	const oauthHits = await within(googleCard!).findAllByText(/oauth_creds\.json/i);
	expect(oauthHits.length).toBeGreaterThan(0);
	const textarea = googleCard!.querySelector('textarea') as HTMLTextAreaElement;
	fireEvent.change(textarea, {
		target: {
			value: JSON.stringify({
				access_token: 'ya29.test',
				refresh_token: '1//0g-rt-component',
				token_type: 'Bearer',
				scope: 'https://www.googleapis.com/auth/generative-language',
				expiry_date: 1745780000000,
			}),
		},
	});
	await user.click(within(googleCard!).getByRole('button', { name: 'Save' }));

	await findByText('Subscription', undefined, { timeout: 15_000 });
});

test('renders API key + Subscription side-by-side and can flip the default', async () => {
	const { container, findByRole, findByText, user, ctx } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
			const apiRes = await postProvider({
				provider: 'openai',
				api_key: 'sk-mix-test',
				label: 'openai-mix-api',
				auth_method: 'api_key',
			});
			expect(apiRes.status).toBe(201);
			const subRes = await postProvider({
				provider: 'openai',
				api_key: JSON.stringify({ tokens: { refresh_token: 'rt-mix' } }),
				label: 'openai-mix-subscription',
				auth_method: 'subscription',
			});
			expect(subRes.status).toBe(201);
		},
	});

	await findByRole('heading', { name: 'AI providers' });

	const settingCards = Array.from(
		container.querySelectorAll<HTMLElement>('div.border.border-border.rounded-radius-md.p-3'),
	);
	const openaiCard = settingCards.find((el) => el.textContent?.includes('OpenAI'));
	expect(openaiCard).toBeTruthy();

	// Wait for the config rows to render — useAiProviders is async even though
	// we already POSTed the configs in seed.
	await waitFor(
		() => {
			expect(within(openaiCard!).queryAllByText('Subscription').length).toBeGreaterThan(0);
			expect(within(openaiCard!).queryAllByText('API Key').length).toBeGreaterThan(0);
		},
		{ timeout: 15_000 },
	);
	expect(within(openaiCard!).queryByText('Default')).toBeTruthy();
	expect(within(openaiCard!).queryByRole('button', { name: /Use Codex subscription/i })).toBeNull();
	expect(within(openaiCard!).queryByRole('button', { name: 'Enter API key' })).toBeNull();

	const setDefaultBtn = within(openaiCard!).getAllByRole('button', { name: 'Set default' })[0];
	fireEvent.click(setDefaultBtn);

	await waitFor(
		async () => {
			const res = await ctx.apiBase('/api/ai-providers', {
				headers: { Authorization: `Bearer ${ctx.token}` },
			});
			const body = (await res.json()) as {
				data: Array<{
					id: string;
					auth_method: string;
					is_default: boolean;
					provider: string;
				}>;
			};
			const defaultConfig = body.data.find((c) => c.is_default && c.provider === 'openai');
			expect(defaultConfig?.auth_method).toBe('subscription');
		},
		{ timeout: 15_000 },
	);
});

test('blocks the app when no provider is configured and drops once one is added', async () => {
	const { container, findByRole, queryAllByRole, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			await clearAiProviders();
		},
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });
	expect(queryAllByRole('heading', { name: 'AI providers' }).length).toBe(0);

	const modalCards = Array.from(
		container.querySelectorAll<HTMLElement>('div.border.border-border.rounded-radius-md.p-4'),
	);
	const anthropicCard = modalCards.find((el) => el.textContent?.includes('Anthropic'));
	expect(anthropicCard).toBeTruthy();

	await user.click(within(anthropicCard!).getByRole('button', { name: 'Enter API key' }));
	const keyInput = anthropicCard!.querySelector('input[type="password"]') as HTMLInputElement;
	fireEvent.change(keyInput, { target: { value: 'sk-ant-gate-component-12345' } });
	await user.click(within(anthropicCard!).getByRole('button', { name: 'Save' }));

	// Gate drops once the provider lands and the app shell renders.
	await waitFor(
		() => {
			expect(
				container.querySelector('[data-testid="home-welcome-card"]') ??
					container.querySelector('[data-testid="home-onboarding-choice-section"]') ??
					container.querySelector('nav'),
			).toBeTruthy();
		},
		{ timeout: 15_000 },
	);
});

test('re-raises the gate after deleting the last provider', async () => {
	const { findByRole } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	await findByRole('heading', { name: 'AI providers' });

	await clearAiProviders();
	// The SetupGate observes ['ai-providers', 'status'] on the singleton query
	// client; the status query has a stale window, so refetch explicitly.
	await singletonQueryClient.invalidateQueries({ queryKey: ['ai-providers', 'status'] });

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });
});

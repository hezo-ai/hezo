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

test('Add provider modal shows a card for every offered provider (incl. OpenRouter and the local runners)', async () => {
	const { findByRole, getByRole, queryAllByText, queryAllByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	await findByRole('heading', { name: 'AI providers' });
	await user.click(getByRole('button', { name: 'Add provider' }));

	const dialog = await findByRole('dialog');
	// The picker step renders one selectable card per provider (each card's
	// accessible name is just the provider name). A provider missing here is
	// unreachable in the UI even though the API accepts it, so this list is the
	// guard on ADD_PROVIDER_ORDER staying in sync with the AiProvider enum.
	for (const name of [
		'Anthropic',
		'OpenAI',
		'Google',
		'DeepSeek',
		'Kimi',
		'Kimi Code',
		'xAI',
		'OpenRouter',
		'Ollama',
		'LM Studio',
	]) {
		// Exact accessible-name match, not `new RegExp(name)`: a substring pattern
		// makes any provider whose name prefixes another ambiguous, which is exactly
		// what "Kimi" vs "Kimi Code" would do.
		expect(within(dialog).getByRole('button', { name })).toBeTruthy();
	}
	// Cards show only the logo + name now — the runtime label is no longer on them.
	expect(queryAllByText('Grok Build').length).toBe(0);
	expect(queryAllByText('Moonshot').length).toBe(0);
	expect(queryAllByRole('button', { name: /OAuth/i }).length).toBe(0);
});

test('a local provider asks for a Server URL, keeps the key optional, and warns on localhost', async () => {
	const { findByRole, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	await findByRole('heading', { name: 'AI providers' });
	await user.click(getByRole('button', { name: 'Add provider' }));

	const dialog = await findByRole('dialog');
	await user.click(within(dialog).getByRole('button', { name: /Ollama/ }));

	// The Server URL field replaces the key as the required input, prefilled with
	// the runner's documented default.
	const urlField = within(dialog).getByLabelText('Server URL') as HTMLInputElement;
	expect(urlField.value).toBe('http://localhost:11434');
	// The key is explicitly optional for a local runner.
	within(dialog).getByLabelText('API key (optional)');

	// localhost inside the agent container is the container itself, so the form
	// warns and points at host.docker.internal. This is the likeliest misconfig.
	// Scoped to the dialog: it renders in a Radix portal, and the instructions box
	// mentions the same hostname, so a document-wide match would be ambiguous.
	await within(dialog).findByText(/means the container itself/);

	// A reachable host clears the warning; submit stays enabled (no key needed).
	await user.clear(urlField);
	await user.type(urlField, 'http://host.docker.internal:11434');
	await waitFor(() => {
		expect(within(dialog).queryByText(/means the container itself/)).toBeNull();
	});
	const submit = within(dialog).getByRole('button', { name: 'Add provider' });
	expect((submit as HTMLButtonElement).disabled).toBe(false);
});

test('a hosted provider still requires a key and shows no Server URL field', async () => {
	const { findByRole, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	await findByRole('heading', { name: 'AI providers' });
	await user.click(getByRole('button', { name: 'Add provider' }));

	const dialog = await findByRole('dialog');
	await user.click(within(dialog).getByRole('button', { name: /DeepSeek/ }));

	expect(within(dialog).queryByLabelText('Server URL')).toBeNull();
	within(dialog).getByLabelText('API key');
	// Nothing typed yet, so the submit stays disabled until a key is entered.
	const submit = within(dialog).getByRole('button', { name: 'Add provider' });
	expect((submit as HTMLButtonElement).disabled).toBe(true);
});

test('the add picker renders a brand logo for every offered provider (OpenAI, DeepSeek, z.ai, Kimi included)', async () => {
	const { findByRole, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	await findByRole('heading', { name: 'AI providers' });
	await user.click(getByRole('button', { name: 'Add provider' }));

	const dialog = await findByRole('dialog');
	// Every card renders an inline brand SVG in its logo slot — including the ones
	// that used to fall back to a bare wordmark (OpenAI, DeepSeek, z.ai, Kimi).
	for (const name of ['Anthropic', 'OpenAI', 'Google', 'DeepSeek', 'z.ai', 'Kimi', 'Kimi Code']) {
		const card = within(dialog).getByRole('button', { name });
		expect(card.querySelector('svg')).toBeTruthy();
	}
});

test('drilling into a provider shows its brand mark and a single "Connect …" label, and Back returns to the picker', async () => {
	const { findByRole, getByRole, getByText, queryByText, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			// Clear the default seeded provider so the gate renders the picker grid.
			await clearAiProviders();
		},
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });

	// DeepSeek has a registered brand SVG, so its card renders the mark instead of
	// a big-font wordmark.
	const deepSeekCard = getByRole('button', { name: 'DeepSeek' });
	expect(deepSeekCard.querySelector('svg')).toBeTruthy();
	await user.click(deepSeekCard);

	// The header names the provider once, in the "Connect …" label. The small
	// (24px) icon slot renders the brand mark — never a second full-name wordmark,
	// which used to overflow the box, overlap the label, and cover the Back button.
	getByText('Connect DeepSeek');
	expect(queryByText('DeepSeek', { exact: true })).toBeNull();

	// Back is reachable and returns to the card grid, so the provider that was
	// only listed there (its own card) is selectable again.
	await user.click(getByRole('button', { name: 'Back' }));
	await findByRole('button', { name: 'DeepSeek' });
});

test('sidebar Settings link reaches Settings and the AI providers subpage', async () => {
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

	// AI providers is now its own subpage reached from the Settings nav.
	const aiLink = getAllByRole('link', { name: 'AI providers' }).find(
		(l) => l.getAttribute('href') === '/settings/ai-providers',
	);
	if (!aiLink) throw new Error('AI providers nav link not found');
	await user.click(aiLink);
	await waitFor(() => expect(router.state.location.pathname).toBe('/settings/ai-providers'), {
		timeout: 10_000,
	});
	await findByRole('heading', { name: 'AI providers' });
	await findByText('Anthropic');
});

test('can add an Anthropic API key via the settings UI', async () => {
	const { container, findByRole, findByText, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			// Clear the default seeded provider so the gate (card grid) renders.
			await clearAiProviders();
		},
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });

	// Pick the Anthropic card from the grid, then fill its API-key form.
	await user.click(getByRole('button', { name: 'Anthropic' }));
	const keyInput = container.querySelector('input[type="password"]') as HTMLInputElement;
	fireEvent.change(keyInput, { target: { value: 'sk-ant-component-test-1234567890' } });
	await user.click(getByRole('button', { name: 'Save' }));

	// Once a provider is configured the gate drops and the settings page renders.
	await findByText('verified', undefined, { timeout: 15_000 });
});

test('offers Claude Code subscription (setup-token) paste flow for Anthropic', async () => {
	const { container, findAllByText, findByRole, findByText, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
		},
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });

	await user.click(getByRole('button', { name: 'Anthropic' }));
	await user.click(getByRole('button', { name: /Claude Code subscription/i }));
	const setupHits = await findAllByText(/setup-token/i);
	expect(setupHits.length).toBeGreaterThan(0);
	const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
	fireEvent.change(textarea, { target: { value: 'sk-ant-oat01-component-test-token' } });
	await user.click(getByRole('button', { name: 'Save' }));

	await findByText('Subscription', undefined, { timeout: 15_000 });
});

test('Kimi offers only an API-key form (no subscription, runs on Claude Code/Moonshot)', async () => {
	const { container, findByRole, findByText, getByRole, queryByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
		},
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });

	await user.click(getByRole('button', { name: 'Kimi' }));
	// Kimi is api-key only now — no subscription toggle, no `kimi login` flow.
	expect(queryByRole('button', { name: /subscription/i })).toBeNull();
	const keyInput = container.querySelector('input[type="password"]') as HTMLInputElement;
	expect(keyInput).toBeTruthy();
	fireEvent.change(keyInput, { target: { value: 'sk-kimi-component-test' } });
	await user.click(getByRole('button', { name: 'Save' }));

	await findByText('verified', undefined, { timeout: 15_000 });
});

test('offers Codex subscription paste flow for OpenAI', async () => {
	const { container, findAllByText, findByRole, findByText, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
		},
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });

	await user.click(getByRole('button', { name: 'OpenAI' }));
	await user.click(getByRole('button', { name: /Codex subscription/i }));
	const codexHits = await findAllByText(/codex login/i);
	expect(codexHits.length).toBeGreaterThan(0);
	const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
	fireEvent.change(textarea, {
		target: { value: JSON.stringify({ tokens: { refresh_token: 'rt-component-paste' } }) },
	});
	await user.click(getByRole('button', { name: 'Save' }));

	await findByText('Subscription', undefined, { timeout: 15_000 });
});

test('offers Gemini subscription paste flow for Google', async () => {
	const { container, findAllByText, findByRole, findByText, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
		},
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });

	await user.click(getByRole('button', { name: 'Google' }));
	await user.click(getByRole('button', { name: /Gemini subscription/i }));
	const oauthHits = await findAllByText(/oauth_creds\.json/i);
	expect(oauthHits.length).toBeGreaterThan(0);
	const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
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
	await user.click(getByRole('button', { name: 'Save' }));

	await findByText('Subscription', undefined, { timeout: 15_000 });
});

test('lists API key + Subscription rows for a provider and flips the default', async () => {
	const { findByRole, findByText, getByRole, queryAllByText, ctx } = await renderApp({
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

	// Both configs render as their own rows in the table.
	await findByText('openai-mix-api');
	await findByText('openai-mix-subscription');
	await waitFor(
		() => {
			expect(queryAllByText('Subscription').length).toBeGreaterThan(0);
			expect(queryAllByText('API Key').length).toBeGreaterThan(0);
		},
		{ timeout: 15_000 },
	);
	// The first-created config is the (single, instance-wide) default and shows the badge.
	expect(queryAllByText('Default').length).toBe(1);

	const setDefaultBtn = getByRole('button', { name: 'Set openai-mix-subscription as default' });
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

test('flips the single instance-wide default across two different providers', async () => {
	const { findByRole, findByText, getByRole, queryAllByText, ctx } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
			// First config added anywhere becomes the single global default.
			const anthropic = await postProvider({
				provider: 'anthropic',
				api_key: 'sk-ant-default-x',
				label: 'anthropic-x',
			});
			expect(anthropic.status).toBe(201);
			const google = await postProvider({
				provider: 'google',
				api_key: 'gm-default-x',
				label: 'google-x',
			});
			expect(google.status).toBe(201);
		},
	});

	await findByRole('heading', { name: 'AI providers' });
	await findByText('anthropic-x');
	await findByText('google-x');

	// Exactly one config across all providers is the default, always badged.
	await waitFor(() => expect(queryAllByText('Default').length).toBe(1), { timeout: 15_000 });

	// Promote the other provider's config — the default moves globally.
	fireEvent.click(getByRole('button', { name: 'Set google-x as default' }));

	await waitFor(
		async () => {
			const res = await ctx.apiBase('/api/ai-providers', {
				headers: { Authorization: `Bearer ${ctx.token}` },
			});
			const body = (await res.json()) as {
				data: Array<{ provider: string; is_default: boolean }>;
			};
			const defaults = body.data.filter((c) => c.is_default);
			expect(defaults.length).toBe(1);
			expect(defaults[0].provider).toBe('google');
		},
		{ timeout: 15_000 },
	);
});

test('renames a provider config in place from the table', async () => {
	const { findByRole, findByText, getByRole, queryByText, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
			const res = await postProvider({
				provider: 'anthropic',
				api_key: 'sk-ant-rename-component',
				label: 'anthropic-old-name',
			});
			expect(res.status).toBe(201);
		},
	});

	await findByRole('heading', { name: 'AI providers' });
	await findByText('anthropic-old-name');

	await user.click(getByRole('button', { name: 'Rename anthropic-old-name' }));
	const input = getByRole('textbox', {
		name: 'New name for anthropic-old-name',
	}) as HTMLInputElement;
	// The editor opens pre-filled with the current name.
	expect(input.value).toBe('anthropic-old-name');
	fireEvent.change(input, { target: { value: 'anthropic-shiny' } });
	await user.click(getByRole('button', { name: 'Save name for anthropic-old-name' }));

	// The row re-renders under the new name once the refetch lands.
	await findByText('anthropic-shiny', undefined, { timeout: 15_000 });
	await waitFor(() => expect(queryByText('anthropic-old-name')).toBeNull());
});

test('cancelling a rename restores the read-only label unchanged', async () => {
	const { findByRole, findByText, getByRole, queryByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
			const res = await postProvider({
				provider: 'anthropic',
				api_key: 'sk-ant-rename-cancel',
				label: 'anthropic-keep-name',
			});
			expect(res.status).toBe(201);
		},
	});

	await findByRole('heading', { name: 'AI providers' });
	await findByText('anthropic-keep-name');

	await user.click(getByRole('button', { name: 'Rename anthropic-keep-name' }));
	const input = getByRole('textbox', {
		name: 'New name for anthropic-keep-name',
	}) as HTMLInputElement;
	fireEvent.change(input, { target: { value: 'discarded-edit' } });
	await user.click(getByRole('button', { name: 'Cancel renaming anthropic-keep-name' }));

	// Editor closes without saving; the original label still renders.
	expect(queryByRole('textbox', { name: 'New name for anthropic-keep-name' })).toBeNull();
	await findByText('anthropic-keep-name');
});

test('Add provider modal pre-fills a default name from the selected provider', async () => {
	const { findByRole, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	await findByRole('heading', { name: 'AI providers' });
	await user.click(getByRole('button', { name: 'Add provider' }));

	const dialog = await findByRole('dialog');
	// Pick the Anthropic card; the Name field pre-fills from the provider.
	await user.click(within(dialog).getByRole('button', { name: /Anthropic/ }));
	const nameInput = within(dialog).getByLabelText('Name') as HTMLInputElement;
	// Default seed only uses the label "test-default", so "Anthropic" is free.
	await waitFor(() => expect(nameInput.value).toBe('Anthropic'));

	// Back to the grid, pick Google: the default name follows the new provider.
	await user.click(within(dialog).getByRole('button', { name: 'Back' }));
	await user.click(within(dialog).getByRole('button', { name: /Google/ }));
	const googleNameInput = within(dialog).getByLabelText('Name') as HTMLInputElement;
	await waitFor(() => expect(googleNameInput.value).toBe('Google'));
});

test('Add provider modal increments the default name when the label is taken', async () => {
	const { findByRole, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
			const res = await postProvider({
				provider: 'anthropic',
				api_key: 'sk-ant-existing',
				label: 'Anthropic',
			});
			expect(res.status).toBe(201);
		},
	});

	await findByRole('heading', { name: 'AI providers' });
	await user.click(getByRole('button', { name: 'Add provider' }));

	const dialog = await findByRole('dialog');
	await user.click(within(dialog).getByRole('button', { name: /Anthropic/ }));
	const nameInput = within(dialog).getByLabelText('Name') as HTMLInputElement;
	await waitFor(() => expect(nameInput.value).toBe('Anthropic 2'));
});

test('adds an API key provider via the Add modal', async () => {
	const { findByRole, findByText, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	await findByRole('heading', { name: 'AI providers' });
	await user.click(getByRole('button', { name: 'Add provider' }));

	const dialog = await findByRole('dialog');
	await user.click(within(dialog).getByRole('button', { name: /Google/ }));

	const nameInput = within(dialog).getByLabelText('Name') as HTMLInputElement;
	fireEvent.change(nameInput, { target: { value: 'My Gemini' } });
	const keyInput = within(dialog).getByLabelText('API key') as HTMLInputElement;
	fireEvent.change(keyInput, { target: { value: 'gm-test-key-123' } });

	await user.click(within(dialog).getByRole('button', { name: 'Add provider' }));

	// Modal closes and the new row appears under its label.
	await findByText('My Gemini', undefined, { timeout: 15_000 });
});

test('adds a subscription credential via the Add modal', async () => {
	const { findByRole, findByText, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	await findByRole('heading', { name: 'AI providers' });
	await user.click(getByRole('button', { name: 'Add provider' }));

	const dialog = await findByRole('dialog');
	await user.click(within(dialog).getByRole('button', { name: /OpenAI/ }));
	await user.click(within(dialog).getByRole('button', { name: /Codex subscription/i }));

	// "codex login" appears in both a step and the footer, so match all.
	await within(dialog).findAllByText(/codex login/i);
	const textarea = within(dialog).getByLabelText('Subscription credential') as HTMLTextAreaElement;
	fireEvent.change(textarea, {
		target: { value: JSON.stringify({ tokens: { refresh_token: 'rt-modal' } }) },
	});

	await user.click(within(dialog).getByRole('button', { name: 'Add provider' }));

	await findByText('Subscription', undefined, { timeout: 15_000 });
});

test('blocks the app when no provider is configured and drops once one is added', async () => {
	const { container, findByRole, getByRole, queryAllByRole, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			await clearAiProviders();
		},
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });
	expect(queryAllByRole('heading', { name: 'AI providers' }).length).toBe(0);

	// Pick the Anthropic card from the grid, then fill its API-key form.
	await user.click(getByRole('button', { name: 'Anthropic' }));
	const keyInput = container.querySelector('input[type="password"]') as HTMLInputElement;
	fireEvent.change(keyInput, { target: { value: 'sk-ant-gate-component-12345' } });
	await user.click(getByRole('button', { name: 'Save' }));

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

/**
 * Point the provider catalog call (a live fetch inside the `/models` route) at a
 * fixed model list, so the default-model dropdown can be exercised without the
 * real network. Other requests keep flowing through the harness fetch.
 */
function stubProviderCatalog(ids: string[]): void {
	const harnessFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.includes('/v1/models') || url.includes('api.anthropic.com')) {
			return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return harnessFetch(input as RequestInfo | URL, init);
	}) as typeof fetch;
}

test('the default-model dropdown loads models dynamically on hover intent', async () => {
	stubProviderCatalog(['claude-opus-4-8', 'claude-sonnet-4-6']);

	const { findByRole } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
			const res = await postProvider({
				provider: 'anthropic',
				api_key: 'sk-ant-models-dropdown',
				label: 'anthropic-models',
			});
			expect(res.status).toBe(201);
		},
	});

	await findByRole('heading', { name: 'AI providers' });
	const select = (await findByRole('combobox', {
		name: 'Default model for anthropic-models',
	})) as HTMLSelectElement;

	// A native <select> opens on the same click that focuses it, so the query is
	// prefetched on pointer-enter — by the time the list opens, the fetched models
	// are already mounted as options.
	fireEvent.pointerEnter(select);

	await waitFor(
		() => {
			const values = Array.from(select.querySelectorAll('option')).map((o) => o.value);
			expect(values).toContain('claude-opus-4-8');
			expect(values).toContain('claude-sonnet-4-6');
		},
		{ timeout: 10_000 },
	);
});

test('a subscription provider shows a CLI-default note instead of a model list', async () => {
	// No catalog stub: subscription auth must not attempt the live listing at all,
	// so a real fetch would be the bug this asserts against.
	const { findByRole, findByText, queryByText } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
			const res = await postProvider({
				provider: 'anthropic',
				api_key: 'sk-ant-oat01-subscription-note-token',
				auth_method: 'subscription',
				label: 'anthropic-sub',
			});
			expect(res.status).toBe(201);
		},
	});

	await findByRole('heading', { name: 'AI providers' });
	await findByText('anthropic-sub');

	// The row degrades to a friendly note; no error is surfaced.
	await findByText('CLI default (subscription)', undefined, { timeout: 10_000 });
	expect(queryByText('Failed to load models')).toBeNull();
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

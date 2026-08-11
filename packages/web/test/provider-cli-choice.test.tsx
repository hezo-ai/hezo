import { AgentRuntime, AiProvider } from '@hezo/shared';
import { fireEvent, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

interface ProviderListResponse {
	data: Array<{ id: string; label: string; runtime: string | null }>;
}

/**
 * Remove the harness's seeded credential so the setup gate renders its provider
 * card grid — the same shortcut the existing ai-providers specs use to reach the
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

async function listProviders(): Promise<ProviderListResponse['data']> {
	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/ai-providers', {
		headers: { Authorization: `Bearer ${token}` },
	});
	return ((await res.json()) as ProviderListResponse).data;
}

test('a local provider discloses its optional API key and no CLI picker', async () => {
	const { container, findByRole, getByRole, queryByText, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: clearAiProviders,
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });
	await user.click(getByRole('button', { name: 'Ollama' }));

	// A self-hosted runner usually has no auth, so the key must not sit on the
	// default path where it reads as required. Server URL is the only field.
	expect(container.querySelector('input[type="password"]')).toBeNull();
	expect(container.querySelector('input[type="url"]')).not.toBeNull();

	await user.click(await findByRole('button', { name: 'Advanced' }));
	expect(container.querySelector('input[type="password"]')).not.toBeNull();
	// Ollama runs only on Claude Code, so Advanced holds the key and nothing else.
	expect(queryByText('Agent CLI')).toBeNull();
});

test('a provider with a CLI choice discloses it, collapsed, with the default preselected', async () => {
	const { findByRole, getByRole, queryByText, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: clearAiProviders,
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });
	await user.click(getByRole('button', { name: 'Kimi' }));

	const advanced = await findByRole('button', { name: 'Advanced' });
	// Collapsed by default: the ordinary add-a-key path never sees the picker.
	expect(advanced.getAttribute('aria-expanded')).toBe('false');
	expect(queryByText('Agent CLI')).toBeNull();

	await user.click(advanced);
	expect(advanced.getAttribute('aria-expanded')).toBe('true');
	await findByRole('heading', { name: 'Set up an AI provider' });

	// Every CLI this provider can run is offered, and its own default carries the
	// marker — Moonshot's key reaches the same upstream on both.
	const claudeCode = getByRole('button', { name: /^Claude Code/ });
	const kimiCode = getByRole('button', { name: /^Kimi Code/ });
	expect(claudeCode.textContent).toContain('Default');
	expect(kimiCode.textContent).not.toContain('Default');
});

test('the chosen CLI is submitted with the credential', async () => {
	const { container, findByRole, findByText, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: clearAiProviders,
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });
	await user.click(getByRole('button', { name: 'Kimi' }));

	await user.click(await findByRole('button', { name: 'Advanced' }));
	// Switch off this provider's default (Claude Code) onto Moonshot's own CLI.
	await user.click(getByRole('button', { name: /^Kimi Code/ }));

	const keyInput = container.querySelector('input[type="password"]') as HTMLInputElement;
	fireEvent.change(keyInput, { target: { value: 'sk-moonshot-component-test' } });
	await user.click(getByRole('button', { name: 'Save' }));

	await findByText('verified', undefined, { timeout: 15_000 });
	const configs = await listProviders();
	expect(configs.length).toBe(1);
	expect(configs[0].runtime).toBe(AgentRuntime.Kimi);
});

test('the provider list renders the resolved CLI and changes it from the Edit dialog', async () => {
	const { findByRole, findByText, getByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
			// Stored runtime is null, so the row has to fall back to the provider
			// default rather than rendering an empty cell.
			await postProvider({ provider: AiProvider.Kimi, api_key: 'sk-moonshot', label: 'Kimi' });
		},
	});

	await findByRole('heading', { name: 'AI providers' }, { timeout: 15_000 });
	await findByText('Claude Code');

	await user.click(getByRole('button', { name: 'Edit Kimi' }));
	const dialog = await findByRole('dialog');
	// The CLI picker lives behind the Advanced disclosure, same as when adding.
	await user.click(within(dialog).getByRole('button', { name: 'Advanced' }));
	await user.click(within(dialog).getByRole('button', { name: /^Kimi Code/ }));
	await user.click(within(dialog).getByRole('button', { name: 'Save' }));

	await findByText('Kimi Code', undefined, { timeout: 15_000 });
	const configs = await listProviders();
	expect(configs.find((c) => c.label === 'Kimi')?.runtime).toBe(AgentRuntime.Kimi);
});

test('a single-CLI provider offers no CLI picker in its Edit dialog', async () => {
	const { findByRole, findByText, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
			await postProvider({
				provider: AiProvider.Ollama,
				base_url: 'http://host.docker.internal:11434',
				label: 'Ollama',
			});
		},
	});

	await findByRole('heading', { name: 'AI providers' }, { timeout: 15_000 });
	await findByText('Claude Code');

	await user.click(await findByRole('button', { name: 'Edit Ollama' }));
	const dialog = await findByRole('dialog');
	// Ollama runs only on Claude Code, so Advanced carries its optional key and
	// no picker — a one-CLI choice is not a choice.
	await user.click(within(dialog).getByRole('button', { name: 'Advanced' }));
	expect(within(dialog).queryByText('Agent CLI')).toBeNull();
	expect(dialog.querySelector('input[type="password"]')).not.toBeNull();
});

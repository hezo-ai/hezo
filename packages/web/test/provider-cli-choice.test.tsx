import { AgentRuntime, AiProvider } from '@hezo/shared';
import { fireEvent } from '@testing-library/react';
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

test('a provider that runs on one CLI shows no Advanced section', async () => {
	const { findByRole, getByRole, queryByRole, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: clearAiProviders,
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });
	await user.click(getByRole('button', { name: 'Anthropic' }));

	// Anthropic runs only on Claude Code, so there is nothing to disclose and the
	// trigger is omitted rather than opening onto an empty box.
	expect(queryByRole('button', { name: 'Advanced' })).toBeNull();
});

test('a provider with a CLI choice discloses it, collapsed, with the default preselected', async () => {
	const { findByRole, getByRole, queryByText, user } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: clearAiProviders,
	});

	await findByRole('heading', { name: 'Set up an AI provider' }, { timeout: 15_000 });
	await user.click(getByRole('button', { name: 'Kimi Code' }));

	const advanced = await findByRole('button', { name: 'Advanced' });
	// Collapsed by default: the ordinary add-a-key path never sees the picker.
	expect(advanced.getAttribute('aria-expanded')).toBe('false');
	expect(queryByText('Agent CLI')).toBeNull();

	await user.click(advanced);
	expect(advanced.getAttribute('aria-expanded')).toBe('true');
	await findByRole('heading', { name: 'Set up an AI provider' });

	// Both CLIs are offered and this provider's own default carries the marker.
	const kimiCode = getByRole('button', { name: /^Kimi Code/ });
	const claudeCode = getByRole('button', { name: /^Claude Code/ });
	expect(kimiCode.textContent).toContain('Default');
	expect(claudeCode.textContent).not.toContain('Default');
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

test('the provider list renders the resolved CLI and changes it in place', async () => {
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

	const trigger = await findByRole('button', { name: 'Change agent CLI' });
	expect(trigger.textContent).toBe('Claude Code');

	await user.click(trigger);
	await user.click(getByRole('button', { name: /^Kimi Code/ }));

	await findByText('Kimi Code', undefined, { timeout: 15_000 });
	const configs = await listProviders();
	expect(configs.find((c) => c.label === 'Kimi')?.runtime).toBe(AgentRuntime.Kimi);
});

test('a single-CLI provider row shows its runtime as plain text, not a control', async () => {
	const { findByRole, findByText, queryByRole } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	// The harness seeds an Anthropic credential, which runs only on Claude Code.
	await findByRole('heading', { name: 'AI providers' }, { timeout: 15_000 });
	await findByText('Claude Code');
	expect(queryByRole('button', { name: 'Change agent CLI' })).toBeNull();
});

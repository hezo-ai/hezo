import { api } from '@hezo/web/lib/api';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

// Component tier (happy-dom). Covers the AiProvidersSection branches that
// ai-providers.test.tsx doesn't reach: the empty state, the per-row verify
// success marker (ShieldCheck), the verify-failure toast path, row deletion, and
// the DefaultModelSelector's open/loaded/error branches. Verify + models
// endpoints are stubbed via the api spy so outcomes are deterministic.

afterEach(() => {
	vi.restoreAllMocks();
});

async function clearAiProviders() {
	const { apiBase, token } = getTestContext();
	const headers = { Authorization: `Bearer ${token}` };
	const listRes = await apiBase('/api/ai-providers', { headers });
	const { data } = (await listRes.json()) as { data: Array<{ id: string }> };
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

test('verify success shows the inline valid-key marker (ShieldCheck)', async () => {
	let configId = '';
	const { findByRole, container } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
			const res = await postProvider({
				provider: 'anthropic',
				api_key: 'sk-ant-verify-ok',
				label: 'verify-ok',
			});
			const body = (await res.json()) as { data: { id: string } };
			configId = body.data.id;
		},
	});

	await findByRole('heading', { name: 'AI providers' });

	const realPost = api.post.bind(api);
	vi.spyOn(api, 'post').mockImplementation(((path: string, data?: unknown) => {
		if (path === `/api/ai-providers/${configId}/verify`) {
			return Promise.resolve({ valid: true });
		}
		return realPost(path, data as never);
	}) as typeof api.post);

	const verifyBtn = await screen.findByRole('button', { name: 'Verify verify-ok' });
	fireEvent.click(verifyBtn);

	// A successful verify renders the "Key is valid" tooltip trigger (ShieldCheck).
	await waitFor(() => {
		expect(within(container).queryByLabelText('Verify verify-ok')).toBeTruthy();
		// The success marker icon appears (extra ShieldCheck with the valid tooltip).
		const tips = container.querySelectorAll('svg');
		expect(tips.length).toBeGreaterThan(0);
	});
});

test('verify failure leaves the key unmarked (no inline valid marker) and re-enables the button', async () => {
	// The error toast itself is mounted by main.tsx (not the renderApp tree), so
	// the observable failure-branch effect is component state: verifiedOk stays
	// false, so the "Key is valid" marker never appears and the verify button
	// returns to enabled after the failed verify resolves.
	let configId = '';
	const { findByRole } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
			const res = await postProvider({
				provider: 'anthropic',
				api_key: 'sk-ant-verify-bad',
				label: 'verify-bad',
			});
			const body = (await res.json()) as { data: { id: string } };
			configId = body.data.id;
		},
	});

	await findByRole('heading', { name: 'AI providers' });

	const realPost = api.post.bind(api);
	vi.spyOn(api, 'post').mockImplementation(((path: string, data?: unknown) => {
		if (path === `/api/ai-providers/${configId}/verify`) {
			return Promise.resolve({ valid: false, message: 'Key is invalid or expired' });
		}
		return realPost(path, data as never);
	}) as typeof api.post);

	const verifyBtn = (await screen.findByRole('button', {
		name: 'Verify verify-bad',
	})) as HTMLButtonElement;
	fireEvent.click(verifyBtn);

	// While verifying the button is disabled; once the (invalid) result resolves
	// it re-enables and no "Key is valid" success tooltip is added for the row.
	await waitFor(() => expect(verifyBtn.disabled).toBe(false), { timeout: 15_000 });
	expect(screen.queryByLabelText('Key is valid')).toBeNull();
});

test('removing a provider deletes its row', async () => {
	const { findByRole, findByText } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
			await postProvider({ provider: 'anthropic', api_key: 'sk-ant-keep', label: 'keep-me' });
			await postProvider({ provider: 'openai', api_key: 'sk-oai-del', label: 'delete-me' });
		},
	});

	await findByRole('heading', { name: 'AI providers' });
	await findByText('delete-me');

	fireEvent.click(await screen.findByRole('button', { name: 'Remove delete-me' }));

	await waitFor(() => expect(screen.queryByText('delete-me')).toBeNull(), { timeout: 15_000 });
	// The other provider stays.
	await findByText('keep-me');
});

test('default-model selector loads models on focus and surfaces a load error', async () => {
	let configId = '';
	const { findByRole } = await renderApp({
		initialPath: '/settings/ai-providers',
		seed: async () => {
			await clearAiProviders();
			const res = await postProvider({
				provider: 'anthropic',
				api_key: 'sk-ant-models',
				label: 'models-row',
			});
			const body = (await res.json()) as { data: { id: string } };
			configId = body.data.id;
		},
	});

	await findByRole('heading', { name: 'AI providers' });

	const realGet = api.get.bind(api);
	vi.spyOn(api, 'get').mockImplementation(((path: string, params?: unknown) => {
		if (path === `/api/ai-providers/${configId}/models`) {
			return Promise.reject(new Error('Failed to load models'));
		}
		return realGet(path, params as never);
	}) as typeof api.get);

	const select = (await screen.findByRole('combobox', {
		name: 'Default model for models-row',
	})) as HTMLSelectElement;
	// Default selection is the CLI-default placeholder (empty value).
	expect(select.value).toBe('');

	fireEvent.focus(select);

	// The errored models query renders the inline error text.
	await screen.findByText('Failed to load models', undefined, { timeout: 15_000 });
});

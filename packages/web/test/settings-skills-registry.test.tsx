// Coverage for the skills.sh registry search panel and the delete flow on
// routes/settings/skills.tsx — the parts the existing instance-skills /
// settings-skills specs don't reach: saving a token, the configured search form,
// rendering + installing a result, the no-results and error states, and the
// list-row delete confirm. Component tier (no real layout / WS). The token is set
// for real via the API (PUT /api/skills/registry/token) so the panel renders its
// *configured* search form; only the search / install responses are fetch-mocked,
// because those reach the external skills.sh service server-side.

import type { RegistrySkillSearchResult } from '@hezo/shared';
import { waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

let restoreFetch: (() => void) | null = null;
afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
});

function result(overrides: Partial<RegistrySkillSearchResult>): RegistrySkillSearchResult {
	return {
		id: 'octo/repo/stripe-helper',
		name: 'Stripe Helper',
		source: 'octo/repo',
		slug: 'stripe-helper',
		installs: 1234,
		url: 'https://skills.sh/octo/repo/stripe-helper',
		...overrides,
	};
}

async function setRegistryToken(): Promise<void> {
	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/skills/registry/token', {
		method: 'PUT',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ token: 'sk-registry-test-token' }),
	});
	if (res.status !== 200) throw new Error(`set token failed: ${res.status}`);
}

/**
 * Mock just the registry search + install endpoints (these talk to skills.sh
 * server-side). Must be installed after renderApp's seed has run so it captures
 * the harness fetch as the passthrough. The token-status GET is left to the real
 * backend, which reports configured:true once {@link setRegistryToken} ran.
 */
function installSearchMock(opts: {
	searchResults?: RegistrySkillSearchResult[];
	searchStatus?: number;
	searchError?: { message: string };
}) {
	const original = globalThis.fetch;
	restoreFetch = () => {
		globalThis.fetch = original;
	};
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

		if (method === 'GET' && /\/api\/skills\/registry\/search/.test(url)) {
			if (opts.searchError) {
				return new Response(
					JSON.stringify({ error: { code: 'REGISTRY_ERROR', message: opts.searchError.message } }),
					{ status: opts.searchStatus ?? 400, headers: { 'Content-Type': 'application/json' } },
				);
			}
			return new Response(JSON.stringify({ data: opts.searchResults ?? [] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		if (method === 'POST' && /\/api\/skills\/registry\/install$/.test(url)) {
			return new Response(
				JSON.stringify({ data: { slug: 'stripe-helper', name: 'Stripe Helper' } }),
				{ status: 201, headers: { 'Content-Type': 'application/json' } },
			);
		}
		return original(input as RequestInfo, init);
	}) as typeof globalThis.fetch;
}

test('with no token configured, the search panel prompts to save a token and gates Save on input', async () => {
	const r = await renderApp({ initialPath: '/settings/skills' });

	await r.user.click(await r.findByTestId('toggle-search'));
	const tokenInput = await r.findByLabelText('skills.sh API token');
	expect((tokenInput as HTMLInputElement).type).toBe('password');

	const saveBtn = (await r.findByRole('button', { name: 'Save token' })) as HTMLButtonElement;
	expect(saveBtn.disabled).toBe(true);
	await r.user.type(tokenInput, 'sk-registry-123');
	expect(saveBtn.disabled).toBe(false);
});

test('a configured token shows the search form and renders a result with source, install count, and skills.sh link', async () => {
	const r = await renderApp({
		initialPath: '/settings/skills',
		seed: async () => {
			await setRegistryToken();
			installSearchMock({
				searchResults: [result({ name: 'Stripe Helper', source: 'octo/repo', installs: 4200 })],
			});
		},
	});

	await r.user.click(await r.findByTestId('toggle-search'));
	const searchInput = await r.findByLabelText('Search skills.sh', undefined, { timeout: 15_000 });

	// The form's Search submit button is disabled under 2 chars; type a real query
	// and submit via Enter (two buttons normalize to the name "Search", so the
	// keyboard submit is the unambiguous trigger).
	const searchSubmit = (await r.findByText('Search', { selector: 'button' })) as HTMLButtonElement;
	expect(searchSubmit.disabled).toBe(true);
	await r.user.type(searchInput, 'stripe');
	expect(searchSubmit.disabled).toBe(false);
	await r.user.keyboard('{Enter}');

	await r.findByText('Stripe Helper');
	await r.findByText(/octo\/repo · 4,200 installs/);
	const link = await r.findByLabelText('Open Stripe Helper on skills.sh');
	expect(link.getAttribute('href')).toBe('https://skills.sh/octo/repo/stripe-helper');
	expect(link.getAttribute('target')).toBe('_blank');
});

test('clicking Add on a result installs it via the registry endpoint', async () => {
	let installed = false;
	const r = await renderApp({
		initialPath: '/settings/skills',
		seed: async () => {
			await setRegistryToken();
			// Wrap the install mock to record that it fired.
			const original = globalThis.fetch;
			restoreFetch = () => {
				globalThis.fetch = original;
			};
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;
				const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
				if (method === 'GET' && /\/api\/skills\/registry\/search/.test(url)) {
					return new Response(JSON.stringify({ data: [result({ name: 'Stripe Helper' })] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				if (method === 'POST' && /\/api\/skills\/registry\/install$/.test(url)) {
					installed = true;
					return new Response(
						JSON.stringify({ data: { slug: 'stripe-helper', name: 'Stripe Helper' } }),
						{ status: 201, headers: { 'Content-Type': 'application/json' } },
					);
				}
				return original(input as RequestInfo, init);
			}) as typeof globalThis.fetch;
		},
	});

	await r.user.click(await r.findByTestId('toggle-search'));
	await r.user.type(
		await r.findByLabelText('Search skills.sh', undefined, { timeout: 15_000 }),
		'stripe',
	);
	await r.user.keyboard('{Enter}');

	await r.findByText('Stripe Helper');
	const addButtons = await r.findAllByRole('button', { name: /Add/ });
	await r.user.click(addButtons[addButtons.length - 1]);
	await waitFor(() => expect(installed).toBe(true));
});

test('a registry search error surfaces the error message', async () => {
	const r = await renderApp({
		initialPath: '/settings/skills',
		seed: async () => {
			await setRegistryToken();
			installSearchMock({
				searchError: { message: 'skills.sh is unavailable' },
				searchStatus: 503,
			});
		},
	});

	await r.user.click(await r.findByTestId('toggle-search'));
	await r.user.type(
		await r.findByLabelText('Search skills.sh', undefined, { timeout: 15_000 }),
		'react',
	);
	await r.user.keyboard('{Enter}');

	await r.findByText('skills.sh is unavailable');
});

test('a configured search with no results shows the empty-results message', async () => {
	const r = await renderApp({
		initialPath: '/settings/skills',
		seed: async () => {
			await setRegistryToken();
			installSearchMock({ searchResults: [] });
		},
	});

	await r.user.click(await r.findByTestId('toggle-search'));
	await r.user.type(
		await r.findByLabelText('Search skills.sh', undefined, { timeout: 15_000 }),
		'nonexistent-xyz',
	);
	await r.user.keyboard('{Enter}');

	await r.findByText(/No results for/);
});

test('the Clear token control resets the panel back to the token prompt', async () => {
	const r = await renderApp({
		initialPath: '/settings/skills',
		seed: async () => {
			await setRegistryToken();
		},
	});

	await r.user.click(await r.findByTestId('toggle-search'));
	// Configured form is showing.
	await r.findByLabelText('Search skills.sh', undefined, { timeout: 15_000 });

	await r.user.click(await r.findByRole('button', { name: 'Clear token' }));
	// Clearing the token flips the panel back to the "paste a token" prompt.
	await r.findByLabelText('skills.sh API token');
});

test('a non-superuser sees the "managed by the Admin" notice instead of the skills UI', async () => {
	const r = await renderApp({
		initialPath: '/settings/skills',
		seed: async (ctx) => {
			// Demote the seeded admin so me.is_superuser is false.
			await ctx.db.query('UPDATE users SET is_superuser = false');
		},
	});

	await r.findByText(/Instance skills are managed by the Admin/i);
	// The add/search controls are not rendered for a non-admin.
	expect(r.queryByTestId('toggle-search')).toBeNull();
});

test('confirming the delete dialog removes a skill from the list', async () => {
	const r = await renderApp({
		initialPath: '/settings/skills',
		seed: async (ctx) => {
			await ctx.apiBase('/api/skills', {
				method: 'POST',
				headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'Disposable Skill', content: '# body' }),
			});
		},
	});

	await r.findByText('Disposable Skill');

	// The row delete uses window.confirm; accept it.
	const originalConfirm = window.confirm;
	window.confirm = () => true;
	try {
		await r.user.click(await r.findByLabelText('Delete Disposable Skill'));
		await waitFor(() => expect(r.queryByText('Disposable Skill')).toBeNull());
	} finally {
		window.confirm = originalConfirm;
	}
});

test('declining the delete confirm keeps the skill in the list', async () => {
	const r = await renderApp({
		initialPath: '/settings/skills',
		seed: async (ctx) => {
			await ctx.apiBase('/api/skills', {
				method: 'POST',
				headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'Keep Me Skill', content: '# body' }),
			});
		},
	});

	await r.findByText('Keep Me Skill');

	const originalConfirm = window.confirm;
	window.confirm = () => false;
	try {
		await r.user.click(await r.findByLabelText('Delete Keep Me Skill'));
		await waitFor(() => expect(r.queryByText('Keep Me Skill')).not.toBeNull());
	} finally {
		window.confirm = originalConfirm;
	}
});

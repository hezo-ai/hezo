import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

async function seedInstanceConnector(
	ctx: { token: string; apiBase: (p: string, i?: RequestInit) => Promise<Response> },
	body: Record<string, unknown>,
) {
	const res = await ctx.apiBase('/api/mcp-connections', {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (res.status !== 201) throw new Error(`seed connector failed: ${res.status}`);
}

test('lists seeded instance connectors and creates a new one via the form', async () => {
	const { findByText, getByRole, getByPlaceholderText, user } = await renderApp({
		initialPath: '/settings/connectors',
		seed: async (ctx) => {
			await seedInstanceConnector(ctx, {
				name: 'seeded-docs',
				display_name: 'Seeded Docs',
				kind: 'saas',
				config: { url: 'https://mcp.seeded.example/mcp' },
			});
		},
	});

	await findByText('Connectors');
	await findByText('Seeded Docs');

	await user.click(getByRole('button', { name: 'Add' }));
	await user.type(getByPlaceholderText('Name (e.g. shared-docs)'), 'new-conn');
	await user.type(getByPlaceholderText(/MCP server URL/), 'https://mcp.new.example/mcp');
	await user.click(getByRole('button', { name: 'Add connector' }));

	await findByText('new-conn');
});

test('settings page sidebar links to connectors', async () => {
	const { findByRole, getAllByRole, user, router } = await renderApp({ initialPath: '/settings' });

	await findByRole('heading', { name: 'Settings' });
	const sidebarLink = await waitFor(() => {
		const link = getAllByRole('link', { name: 'Connectors' }).find(
			(l) => l.getAttribute('href') === '/settings/connectors',
		);
		expect(link).toBeTruthy();
		return link as HTMLElement;
	});
	await user.click(sidebarLink);

	expect(router.state.location.pathname).toBe('/settings/connectors');
	await findByRole('heading', { name: 'Connectors' });
});

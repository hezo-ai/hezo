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

	await findByText('Instance connectors');
	await findByText('Seeded Docs');

	await user.click(getByRole('button', { name: 'Add' }));
	await user.type(getByPlaceholderText('Name (e.g. shared-docs)'), 'new-conn');
	await user.type(getByPlaceholderText(/MCP server URL/), 'https://mcp.new.example/mcp');
	await user.click(getByRole('button', { name: 'Add connector' }));

	await findByText('new-conn');
});

test('settings page Instance group links to connectors', async () => {
	const { findByText, getAllByRole, user, router } = await renderApp({ initialPath: '/settings' });

	await findByText('Instance');
	const links = getAllByRole('link', { name: 'Connectors' });
	const instanceLink = links.find((l) => l.getAttribute('href') === '/settings/connectors');
	expect(instanceLink).toBeTruthy();
	await user.click(instanceLink as HTMLElement);

	expect(router.state.location.pathname).toBe('/settings/connectors');
	await findByText('Instance connectors');
});

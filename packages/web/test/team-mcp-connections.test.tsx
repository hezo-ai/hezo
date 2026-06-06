import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

/**
 * Exercises the team-settings MCP servers section, whose create/delete hooks
 * were migrated onto the response-driven + invalidating mutation factories
 * (matching the server-side validateBody work on the same endpoint). The create
 * proves the response-keyed, project-scoped list seed; the delete proves the
 * setQueriesData prune + invalidate across the prefix.
 */

test('adds a SaaS MCP server and lists it, then deletes it', async () => {
	let teamSlug = '';
	const { findByText, findByPlaceholderText, findByRole, queryByText, user, router } =
		await renderApp({
			initialPath: '/',
			seed: async () => {
				const ws = await seedWorkspace();
				teamSlug = ws.team.slug;
			},
		});

	await router.navigate({
		to: '/teams/$teamId/settings/general',
		params: { teamId: teamSlug },
	});

	await user.click(await findByRole('button', { name: 'Add MCP Server' }));
	const nameInput = await findByPlaceholderText('Server name (e.g. exa)');
	await user.type(nameInput, 'exa');
	await user.type(
		await findByPlaceholderText('URL (e.g. https://mcp.exa.ai/mcp)'),
		'https://mcp.exa.ai/mcp',
	);
	// Several sections on this page have an "Add" button; scope to the MCP form's submit.
	const submit = nameInput.closest('form')?.querySelector('button[type="submit"]');
	if (!submit) throw new Error('MCP add submit not found');
	await user.click(submit as HTMLElement);

	// Response-driven create seeds the scoped list; the row appears after refetch.
	await findByText('exa');
	await findByText('https://mcp.exa.ai/mcp');

	await user.click(await findByRole('button', { name: 'Delete exa' }));
	await expect.poll(() => queryByText('https://mcp.exa.ai/mcp')).toBeNull();
});

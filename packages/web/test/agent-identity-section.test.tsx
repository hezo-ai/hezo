// Coverage for the agent identity controls on the Settings page: renaming an
// agent, and the generate-and-pick avatar flow that replaced image upload. Both
// drive the real PATCH /api/projects/:slug/agents/:agentId route.

import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

async function openAgentSettings(agentSlug: string) {
	let ws!: SeededWorkspace;
	const rendered = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});
	await rendered.router.navigate({
		to: '/projects/$projectId/agents/$agentId/settings',
		params: { projectId: ws.internalSlug, agentId: agentSlug },
	});
	return { ...rendered, ws };
}

test('renaming an agent shows the new name in place of its role', async () => {
	const { findByTestId, user, findByText } = await openAgentSettings('engineer');

	const input = (await findByTestId('agent-name-input')) as HTMLInputElement;
	await user.type(input, 'Wren');
	await user.click(await findByTestId('agent-name-save'));

	// The page header switches to the name, with the role kept alongside it so
	// the page still says what this teammate does.
	await findByText('Wren');
	const heading = document.querySelector('h1');
	expect(heading?.textContent).toContain('Wren');
});

test('a role-only agent has no name field', async () => {
	// The Captain is who it is - there is one per team and the role is the name.
	await openAgentSettings('captain');
	expect(document.querySelector('[data-testid="agent-name-input"]')).toBeNull();
});

test('generating an avatar offers three options and saves the picked one', async () => {
	const { findByTestId, user, container } = await openAgentSettings('captain');

	const before = container.querySelector<HTMLImageElement>('img[src^="data:image/svg+xml"]')?.src;

	await user.click(await findByTestId('agent-avatar-generate'));
	const options = document.querySelectorAll('[data-testid="agent-avatar-option"]');
	expect(options.length).toBe(3);

	// Nothing is stored until one is chosen and saved.
	const save = await findByTestId('agent-avatar-save');
	expect((save as HTMLButtonElement).disabled).toBe(true);

	await user.click(options[1] as HTMLElement);
	expect(((await findByTestId('agent-avatar-save')) as HTMLButtonElement).disabled).toBe(false);
	await user.click(await findByTestId('agent-avatar-save'));

	// The picker closes and the stored face has moved on.
	await new Promise((r) => setTimeout(r, 50));
	const after = container.querySelector<HTMLImageElement>('img[src^="data:image/svg+xml"]')?.src;
	expect(after).toBeTruthy();
	expect(after).not.toBe(before);
});

test('there is no image upload control for an agent', async () => {
	await openAgentSettings('captain');
	expect(document.querySelector('[data-testid="agent-icon-input"]')).toBeNull();
	expect(document.querySelector('input[type="file"]')).toBeNull();
});

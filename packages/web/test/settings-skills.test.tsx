import { within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

test('a created skill is editable and deletable (no built-in concept)', async () => {
	const r = await renderApp({ initialPath: '/settings/skills' });

	await r.user.click(await r.findByRole('button', { name: 'Add' }));
	await r.user.type(await r.findByPlaceholderText(/^Name/), 'My Skill');
	await r.user.type(await r.findByLabelText('Skill content'), '# Body');
	await r.user.click(await r.findByRole('button', { name: 'Add skill' }));

	// It appears in the list with both edit and delete affordances…
	await r.findByText('My Skill');
	expect(r.queryByLabelText('Edit My Skill')).not.toBeNull();
	expect(r.queryByLabelText('Delete My Skill')).not.toBeNull();
	// …and no skill is labelled built-in anymore.
	expect(r.queryByText('built-in')).toBeNull();
});

test('the skill content editor previews markdown', async () => {
	const r = await renderApp({ initialPath: '/settings/skills' });

	await r.user.click(await r.findByRole('button', { name: 'Add' }));
	const content = await r.findByLabelText('Skill content');
	await r.user.type(content, '# Hello heading');

	await r.user.click(await r.findByRole('tab', { name: 'Preview' }));
	const preview = await r.findByTestId('skill-content-preview');
	expect(preview.querySelector('h1')?.textContent).toContain('Hello heading');
});

test('the skills.sh search panel is gated on a configured token', async () => {
	const r = await renderApp({ initialPath: '/settings/skills' });

	await r.user.click(await r.findByTestId('toggle-search'));
	// No token configured for a fresh instance → prompts for one instead of searching.
	expect(await r.findByLabelText('skills.sh API token')).toBeTruthy();
});

test('the add form and the registry search panel each close via their own close button', async () => {
	const r = await renderApp({ initialPath: '/settings/skills' });

	// Open both panels: registry search first, then the add form below it.
	await r.user.click(await r.findByTestId('toggle-search'));
	await r.user.click(await r.findByRole('button', { name: 'Add' }));

	const searchPanel = await r.findByTestId('registry-search-panel');
	const addPanel = await r.findByTestId('in-place-form');
	expect(addPanel.textContent).toContain('Add skill');
	expect(searchPanel.textContent).toContain('Search skills.sh');

	// Closing the search panel leaves the add form open…
	await r.user.click(within(searchPanel).getByTestId('in-place-form-close'));
	expect(r.queryByTestId('registry-search-panel')).toBeNull();
	expect(r.queryByTestId('in-place-form')).not.toBeNull();

	// …and the add form closes independently.
	await r.user.click(within(addPanel).getByTestId('in-place-form-close'));
	expect(r.queryByTestId('in-place-form')).toBeNull();
});

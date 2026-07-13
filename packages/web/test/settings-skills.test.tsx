import { waitFor, within } from '@testing-library/react';
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

test('the built-in connector-recipes skill is read-only (Built-in badge, no edit/delete) but viewable', async () => {
	const r = await renderApp({ initialPath: '/settings/skills' });

	// The generated virtual skill is always present in the instance list.
	await r.findByText('Connector Recipes');
	await r.findByText('Built-in');
	// It exposes no edit/delete affordances — the server also rejects mutations…
	expect(r.queryByLabelText('Edit Connector Recipes')).toBeNull();
	expect(r.queryByLabelText('Delete Connector Recipes')).toBeNull();
	// …but it can still be viewed via the read-only view modal.
	expect(r.queryByLabelText('View Connector Recipes')).not.toBeNull();
});

test('the view button opens a modal rendering the skill content as markdown', async () => {
	const r = await renderApp({ initialPath: '/settings/skills' });

	// The built-in skill is always present; open its viewer.
	await r.findByLabelText('View Connector Recipes');
	await r.user.click(r.getByLabelText('View Connector Recipes'));

	// The dialog renders into a body portal and shows the generated content.
	const dialog = await within(document.body).findByTestId('skill-view-dialog');
	expect(within(dialog).getByText('Connector Recipes')).toBeTruthy();
	const content = await within(dialog).findByTestId('skill-view-content');
	// The connector-recipes body has a "Connection patterns" markdown heading.
	expect(content.querySelector('h2')?.textContent).toContain('Connection patterns');
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

test('the "Add default skills" button installs the missing defaults behind a confirmation', async () => {
	const r = await renderApp({ initialPath: '/settings/skills' });

	// A fresh instance seeds no default skills, so the button offers all 15.
	const button = await r.findByTestId('add-default-skills');
	expect(button.textContent).toContain('(15)');
	// None of the defaults are in the list yet.
	expect(r.queryByText('Systematic Debugging')).toBeNull();

	// Clicking opens a confirm modal listing the missing skill names.
	await r.user.click(button);
	const dialog = await within(document.body).findByTestId('confirm-dialog');
	expect(within(dialog).getByTestId('default-skill-names').textContent).toContain('Code Review');

	// Confirming installs them: they appear in the list and the button disappears
	// once the missing-defaults query refetches empty.
	await r.user.click(within(dialog).getByTestId('confirm-dialog-confirm'));
	await r.findByText('Systematic Debugging');
	await waitFor(() => expect(r.queryByTestId('add-default-skills')).toBeNull());
});

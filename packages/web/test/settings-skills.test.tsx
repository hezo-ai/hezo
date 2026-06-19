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

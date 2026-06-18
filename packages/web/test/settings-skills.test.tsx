import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

test('built-in skills show a badge and cannot be deleted (but can be edited)', async () => {
	const r = await renderApp({ initialPath: '/settings/skills' });

	// The seeded find-skills built-in appears in the list…
	await r.findByText('find-skills');
	expect(await r.findByText('built-in')).toBeTruthy();
	// …with no delete affordance, but an edit one.
	expect(r.queryByLabelText('Delete find-skills')).toBeNull();
	expect(r.queryByLabelText('Edit find-skills')).not.toBeNull();
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

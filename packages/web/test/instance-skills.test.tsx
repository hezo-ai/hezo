import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

async function seedInstanceSkill(
	ctx: { token: string; apiBase: (p: string, i?: RequestInit) => Promise<Response> },
	body: Record<string, unknown>,
) {
	const res = await ctx.apiBase('/api/skills', {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (res.status !== 201) throw new Error(`seed skill failed: ${res.status}`);
}

test('lists seeded instance skills and creates a new one via the form', async () => {
	const { findByText, getByRole, getByPlaceholderText, user } = await renderApp({
		initialPath: '/settings/skills',
		seed: async (ctx) => {
			await seedInstanceSkill(ctx, { name: 'Seeded Skill', content: '# Seeded\nbody' });
		},
	});

	await findByText('Instance skills');
	await findByText('Seeded Skill');

	await user.click(getByRole('button', { name: 'Add' }));
	await user.type(getByPlaceholderText('Name (e.g. Commit conventions)'), 'New Skill');
	await user.type(getByPlaceholderText('Skill content (markdown)'), '# New\nhello');
	await user.click(getByRole('button', { name: 'Add skill' }));

	await findByText('New Skill');
});

test('edits an instance skill via the row edit affordance', async () => {
	const { findByText, getByRole, findByDisplayValue, user } = await renderApp({
		initialPath: '/settings/skills',
		seed: async (ctx) => {
			await seedInstanceSkill(ctx, {
				name: 'Editable Skill',
				description: 'old desc',
				content: '# body',
			});
		},
	});

	await findByText('Editable Skill');
	await user.click(getByRole('button', { name: 'Edit Editable Skill' }));

	// The form populates from the GET-by-slug fetch (content omitted from list).
	const descInput = await findByDisplayValue('old desc');
	await user.clear(descInput);
	await user.type(descInput, 'new desc');
	await user.click(getByRole('button', { name: 'Save changes' }));

	await findByText('new desc');
});

test('settings page Instance group links to skills', async () => {
	const { findByText, getAllByRole, user, router } = await renderApp({ initialPath: '/settings' });

	await findByText('Instance');
	const links = getAllByRole('link', { name: 'Skills' });
	const instanceLink = links.find((l) => l.getAttribute('href') === '/settings/skills');
	expect(instanceLink).toBeTruthy();
	await user.click(instanceLink as HTMLElement);

	expect(router.state.location.pathname).toBe('/settings/skills');
	await findByText('Instance skills');
});

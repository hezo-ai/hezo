import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

/**
 * Exercises the team Skills database page, whose create / update / sync / delete
 * hooks were migrated onto the response-driven + invalidating mutation
 * factories. The assertions ride the real React Query refetch the factories
 * drive, so a broken queryKey/merge/invalidate wiring would surface as stale
 * DOM here.
 */

async function seedSkill(ws: SeededWorkspace, body: Record<string, unknown>) {
	const res = await getTestContext().apiBase(`/api/teams/${ws.team.id}/skills`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify(body),
	});
	if (res.status !== 201) throw new Error(`seed skill failed: ${res.status}`);
}

test('lists seeded team skills and creates a new one via the form', async () => {
	let teamSlug = '';
	const { findByText, getByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.team.slug;
			await seedSkill(ws, { name: 'Seeded Skill', content: '# Seeded\nbody' });
		},
	});

	await router.navigate({ to: '/teams/$teamId/skills', params: { teamId: teamSlug } });

	await findByText('Seeded Skill');

	await user.click(getByRole('button', { name: 'New' }));
	await user.type(getByRole('textbox', { name: 'Name' }), 'Fresh Skill');
	await user.type(getByRole('textbox', { name: 'Content (markdown)' }), '# Fresh\nhello');
	await user.click(getByRole('button', { name: 'Create' }));

	// The response-driven create seeds the detail cache and invalidates the
	// list; the new row must appear after the refetch.
	await findByText('Fresh Skill');
});

test('edits a team skill and the list reflects the new name after refetch', async () => {
	let teamSlug = '';
	const { findByText, findByRole, findByDisplayValue, getByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.team.slug;
			await seedSkill(ws, {
				name: 'Editable Skill',
				description: 'old desc',
				content: '# body',
			});
		},
	});

	await router.navigate({ to: '/teams/$teamId/skills', params: { teamId: teamSlug } });

	await user.click(await findByText('Editable Skill'));
	await user.click(await findByRole('button', { name: 'Edit' }));

	const nameInput = await findByDisplayValue('Editable Skill');
	await user.clear(nameInput);
	await user.type(nameInput, 'Renamed Skill');
	await user.click(getByRole('button', { name: 'Save' }));

	// Update is response-driven (detail seeded) + list invalidated — the list
	// pane button picks up the new name.
	await findByText('Renamed Skill');
});

test('deletes a team skill and it disappears from the list', async () => {
	let teamSlug = '';
	const { findByText, findByRole, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			teamSlug = ws.team.slug;
			await seedSkill(ws, { name: 'Doomed Skill', content: '# body' });
		},
	});

	await router.navigate({ to: '/teams/$teamId/skills', params: { teamId: teamSlug } });

	await user.click(await findByText('Doomed Skill'));

	// window.confirm is invoked before the delete fires.
	const originalConfirm = window.confirm;
	window.confirm = () => true;
	try {
		await user.click(await findByRole('button', { name: 'Delete' }));
		await expect.poll(() => queryByText('Doomed Skill')).toBeNull();
	} finally {
		window.confirm = originalConfirm;
	}
});

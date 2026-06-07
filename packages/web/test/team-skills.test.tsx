import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

/**
 * Exercises the project Skills database page, whose create / update / sync /
 * delete hooks ride the response-driven + invalidating mutation factories. The
 * assertions ride the real React Query refetch the factories drive, so a broken
 * queryKey/merge/invalidate wiring would surface as stale DOM here.
 */

interface CreatedTeam {
	id: string;
	slug: string;
}

async function createTeam(): Promise<CreatedTeam> {
	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/teams', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: `Skills Co ${Date.now()}`, description: 'Build things' }),
	});
	return ((await res.json()) as { data: CreatedTeam }).data;
}

async function seedSkill(projectId: string, body: Record<string, unknown>) {
	const { apiBase, token } = getTestContext();
	const res = await apiBase(`/api/projects/${projectId}/skills`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (res.status !== 201) throw new Error(`seed skill failed: ${res.status}`);
}

test('lists seeded project skills and creates a new one via the form', async () => {
	let projectId = '';
	const { findByText, getByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const team = await createTeam();
			projectId = `internal-${team.slug}`;
			await seedSkill(projectId, { name: 'Seeded Skill', content: '# Seeded\nbody' });
		},
	});

	await router.navigate({ to: '/projects/$projectId/skills', params: { projectId } });

	await findByText('Seeded Skill');

	await user.click(getByRole('button', { name: 'New' }));
	await user.type(getByRole('textbox', { name: 'Name' }), 'Fresh Skill');
	await user.type(getByRole('textbox', { name: 'Content (markdown)' }), '# Fresh\nhello');
	await user.click(getByRole('button', { name: 'Create' }));

	// The response-driven create seeds the detail cache and invalidates the
	// list; the new row must appear after the refetch.
	await findByText('Fresh Skill');
});

test('edits a project skill and the list reflects the new name after refetch', async () => {
	let projectId = '';
	const { findByText, findByRole, findByDisplayValue, getByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const team = await createTeam();
			projectId = `internal-${team.slug}`;
			await seedSkill(projectId, {
				name: 'Editable Skill',
				description: 'old desc',
				content: '# body',
			});
		},
	});

	await router.navigate({ to: '/projects/$projectId/skills', params: { projectId } });

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

test('deletes a project skill and it disappears from the list', async () => {
	let projectId = '';
	const { findByText, findByRole, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const team = await createTeam();
			projectId = `internal-${team.slug}`;
			await seedSkill(projectId, { name: 'Doomed Skill', content: '# body' });
		},
	});

	await router.navigate({ to: '/projects/$projectId/skills', params: { projectId } });

	await user.click(await findByText('Doomed Skill'));

	const originalConfirm = window.confirm;
	window.confirm = () => true;
	try {
		await user.click(await findByRole('button', { name: 'Delete' }));
		await expect.poll(() => queryByText('Doomed Skill')).toBeNull();
	} finally {
		window.confirm = originalConfirm;
	}
});

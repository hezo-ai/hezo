import { waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

async function seedSkill(
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

test('the per-project Skills page shows project skills (editable) and globals (read-only)', async () => {
	let projectSlug = '';
	const { findByText, findByTestId, findByRole, findByLabelText, getByText, router, user } =
		await renderApp({
			initialPath: '/',
			seed: async (ctx) => {
				const ws = await seedWorkspace();
				const project = await seedProject(ws, { name: 'Skills Proj' });
				projectSlug = project.slug;
				await seedSkill(ctx, { name: 'A Global Skill', content: '# global' });
				await seedSkill(ctx, {
					name: 'A Project Skill',
					content: '# project v1',
					project_id: project.id,
				});
			},
		});

	await router.navigate({
		to: '/projects/$projectId/skills',
		params: { projectId: projectSlug },
	});

	await findByText('This project');

	// The project-scoped skill renders in the "This project" section with edit/remove.
	const projectRow = (await findByText('A Project Skill')).closest(
		'[data-testid="project-skill-row"]',
	) as HTMLElement;
	expect(within(projectRow).getByLabelText('Edit A Project Skill')).toBeTruthy();
	expect(within(projectRow).getByLabelText('Delete A Project Skill')).toBeTruthy();

	// The global skill renders read-only with a "Global" badge + a manage link.
	const globalRow = (await findByText('A Global Skill')).closest(
		'[data-testid="global-skill-row"]',
	) as HTMLElement;
	expect(within(globalRow).getByText('Global')).toBeTruthy();
	expect(within(globalRow).getByTestId('global-skill-manage-link')).toBeTruthy();
	// No edit/delete affordance on a global row.
	expect(within(globalRow).queryByLabelText('Edit A Global Skill')).toBeNull();
	expect(getByText('Global (all projects)')).toBeTruthy();

	// Edit the project skill inline; the form loads its full content and saves.
	await user.click(within(projectRow).getByLabelText('Edit A Project Skill'));
	const content = (await findByLabelText('Skill content')) as HTMLTextAreaElement;
	await waitFor(() => expect(content.value).toBe('# project v1'));
	await user.clear(content);
	await user.type(content, '# project v2');
	await user.click(await findByRole('button', { name: 'Save changes' }));
	await findByText('A Project Skill');
});

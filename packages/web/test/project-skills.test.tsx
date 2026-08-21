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
	const { findByText, findByRole, findByLabelText, getByText, router, user } = await renderApp({
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

test('a stored global skill is viewable in the read-only modal from the project page', async () => {
	let projectSlug = '';
	const { findByText, router, user } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Viewer Proj' });
			projectSlug = project.slug;
			await seedSkill(ctx, { name: 'Executing Plans', content: '# How to execute plans' });
		},
	});

	await router.navigate({
		to: '/projects/$projectId/skills',
		params: { projectId: projectSlug },
	});

	// The stored global skill renders under "Global (all projects)".
	const globalRow = (await findByText('Executing Plans')).closest(
		'[data-testid="global-skill-row"]',
	) as HTMLElement;

	// Opening its viewer fetches the full skill by id through the project route.
	// That route used to require project_id = :projectId, so a global (project_id
	// NULL) 404'd and the dialog was stuck on "Loading…". Assert the content
	// actually renders now.
	await user.click(within(globalRow).getByLabelText('View Executing Plans'));
	const dialog = await within(document.body).findByTestId('skill-view-dialog');
	const dialogContent = await within(dialog).findByTestId('skill-view-content');
	expect(dialogContent.querySelector('h1')?.textContent).toContain('How to execute plans');
});

test('the built-in connector-recipes skill shows on the project page as a global, viewable in a modal', async () => {
	let projectSlug = '';
	const { findByText, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Recipes Proj' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/skills',
		params: { projectId: projectSlug },
	});

	// The built-in skill is global, so it renders under "Global (all projects)".
	const globalRow = (await findByText('Connector Recipes')).closest(
		'[data-testid="global-skill-row"]',
	) as HTMLElement;
	expect(within(globalRow).getByText('Global')).toBeTruthy();

	// Open its read-only viewer and confirm the generated markdown renders.
	await user.click(within(globalRow).getByLabelText('View Connector Recipes'));
	const dialog = await within(document.body).findByTestId('skill-view-dialog');
	const dialogContent = await within(dialog).findByTestId('skill-view-content');
	expect(dialogContent.querySelector('h2')?.textContent).toContain('Connection patterns');
});

test('project skill revision history previews a past version and restores it', async () => {
	let projectSlug = '';
	const { findByText, findByRole, findByLabelText, findByTestId, getByLabelText, router, user } =
		await renderApp({
			initialPath: '/',
			seed: async (ctx) => {
				const ws = await seedWorkspace();
				const project = await seedProject(ws, { name: 'Rev Proj' });
				projectSlug = project.slug;
				await seedSkill(ctx, {
					name: 'Versioned Project Skill',
					content: 'Project body v1',
					project_id: project.id,
				});
			},
		});

	await router.navigate({
		to: '/projects/$projectId/skills',
		params: { projectId: projectSlug },
	});
	await findByText('Versioned Project Skill');

	// Edit once so the prior content is snapshotted as a revision.
	await user.click(await findByLabelText('Edit Versioned Project Skill'));
	const content = (await findByLabelText('Skill content')) as HTMLTextAreaElement;
	await waitFor(() => expect(content.value).toBe('Project body v1'));
	await user.clear(content);
	await user.type(content, 'Project body v2');
	await user.click(await findByRole('button', { name: 'Save changes' }));

	// Re-open the editor and read revision 1 without loading it into the editor.
	await user.click(await findByLabelText('Edit Versioned Project Skill'));
	await user.click(await findByRole('button', { name: /revision history/i }));
	await findByTestId('revision-history-dialog');
	await findByText('Rev 1');

	await user.click(await findByTestId('revision-view'));
	await findByTestId('viewing-revision-banner');
	expect((await findByTestId('skill-revision-body')).textContent).toContain('Project body v1');
	await user.click(await findByTestId('view-latest'));
	await waitFor(() => expect(getByLabelText('Skill content')).toBeDefined());

	// Restore revision 1 → confirm → the editor reverts.
	await user.click(await findByRole('button', { name: /revision history/i }));
	await user.click(await findByTestId('revision-restore'));
	await user.click(await findByTestId('confirm-dialog-confirm'));
	await waitFor(() =>
		expect((getByLabelText('Skill content') as HTMLTextAreaElement).value).toBe('Project body v1'),
	);
});

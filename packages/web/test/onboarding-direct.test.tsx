import { screen, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

// First-run entry point: the home welcome card's "New project" button opens the
// CreateProjectWithTeamDialog, which is the single doorway to BOTH project
// creation flows — "Create now" (direct) and "Plan with the CEO" (intake).
test('the welcome card opens the dialog exposing both creation flows', async () => {
	const { findByTestId, user } = await renderApp({ initialPath: '/home', seed: async () => {} });

	const create = await findByTestId('home-welcome-create', undefined, { timeout: 15_000 });
	await user.click(create);

	// The dialog opens on its entry step: the two submit buttons are gated behind a
	// team selection, reached via "View all teams".
	await findByTestId('view-all-teams', undefined, { timeout: 15_000 });
	expect(screen.queryByTestId('create-project-submit')).toBeNull();

	await user.click(await findByTestId('view-all-teams'));
	await user.click(await findByTestId('team-type-card-Blank'));

	// Both creation flows are now available (direct vs CEO-assisted).
	await findByTestId('create-project-submit');
	await findByTestId('plan-with-ceo-submit');
});

// Direct flow: filling the dialog and clicking "Create now" stands up a brand-new
// team + its project and lands on the Captain's auto-created planning task.
test('the direct flow creates a project in its own new team and opens the planning task', async () => {
	const projectName = uniqueName('Direct Build');
	const projectSlug = projectName.toLowerCase().replace(/\s+/g, '-');

	const { findByTestId, findByPlaceholderText, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {},
	});

	const create = await findByTestId('home-welcome-create', undefined, { timeout: 15_000 });
	await user.click(create);

	await user.type(await findByPlaceholderText('e.g. Marketing Site'), projectName);
	await user.type(
		await findByPlaceholderText(/What is this project/),
		'A direct-flow project with its own dedicated team.',
	);
	await user.click(await findByTestId('view-all-teams'));
	await user.click(await findByTestId('team-type-card-Blank'));
	await user.click(await findByTestId('create-project-submit'));

	// Lands on the new project's Captain planning task.
	const expected = new RegExp(`^/projects/${projectSlug}/tasks/[a-z0-9-]+$`);
	await waitFor(() => expect(router.state.location.pathname).toMatch(expected), {
		timeout: 30_000,
	});

	// The project landed in a fresh team named after it, distinct from HQ.
	const ctx = getTestContext();
	const allProjects = (
		(await (
			await ctx.apiBase('/api/projects', { headers: { Authorization: `Bearer ${ctx.token}` } })
		).json()) as { data: Array<{ name: string; slug: string; team_slug: string }> }
	).data;
	const created = allProjects.find((p) => p.name === projectName);
	expect(created).toBeTruthy();
	expect(created!.slug).toBe(projectSlug);
	expect(created!.team_slug).not.toBe('default');
}, 60_000);

// CEO-assisted flow: "Plan with the CEO" hands the brief off to the HQ intake
// conversation rather than creating the project immediately.
test('the CEO-assisted flow opens the HQ intake thread instead of creating immediately', async () => {
	const projectName = uniqueName('Planned Build');

	const { findByTestId, findByPlaceholderText, user, router } = await renderApp({
		initialPath: '/home',
		seed: async () => {},
	});

	const create = await findByTestId('home-welcome-create', undefined, { timeout: 15_000 });
	await user.click(create);

	await user.type(await findByPlaceholderText('e.g. Marketing Site'), projectName);
	await user.type(
		await findByPlaceholderText(/What is this project/),
		'A project we want the CEO to scope with us first.',
	);
	await user.click(await findByTestId('view-all-teams'));
	await user.click(await findByTestId('team-type-card-Blank'));
	await user.click(await findByTestId('plan-with-ceo-submit'));

	// Lands on the CEO's intake thread inside HQ (no project created yet).
	await waitFor(
		() => expect(router.state.location.pathname).toMatch(/^\/projects\/hq\/tasks\/hq-\d+$/),
		{
			timeout: 30_000,
		},
	);

	const ctx = getTestContext();
	const projects = (
		(await (
			await ctx.apiBase('/api/projects', { headers: { Authorization: `Bearer ${ctx.token}` } })
		).json()) as { data: Array<{ name: string }> }
	).data;
	expect(projects.some((p) => p.name === projectName)).toBe(false);
}, 60_000);

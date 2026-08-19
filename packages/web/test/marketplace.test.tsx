import { createTestProject, createTestTeam } from '@hezo/server/test/helpers/app';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

test('marketplace list renders the available teams', async () => {
	const { findByTestId, findByText } = await renderApp({ initialPath: '/marketplace' });
	await findByTestId('marketplace-page');
	// The App Team (slug `app-dev`) is served from the committed folder.
	await findByText('App Team');
	await findByTestId('marketplace-card-app-dev');
});

test('marketplace detail shows the roster, version, and changelog with breadcrumbs', async () => {
	const { findByTestId, findByText, getAllByText } = await renderApp({
		initialPath: '/marketplace/app-dev',
	});
	await findByTestId('marketplace-detail');
	// Breadcrumb back to the marketplace.
	await findByText('Team marketplace');
	// Roster is rendered (Captain is always shown, plus specialist roles). Asserted by
	// row rather than by text: "Reports to" now shows the parent role's *title*, so a
	// role that others report to (Architect) legitimately appears more than once.
	await findByTestId('marketplace-roster');
	await findByTestId('roster-row-captain');
	await findByTestId('roster-row-engineer');
	const architect = await findByTestId('roster-row-architect');
	expect(architect.textContent).toContain('Architect');
	// Version badge appears (at least once).
	expect(getAllByText(/^v\d+$/).length).toBeGreaterThan(0);
	// Action buttons are present.
	await findByTestId('marketplace-launch');
	await findByTestId('marketplace-add-existing');
});

test('the marketplace roster shows each role and its avatar, and ships no names', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/marketplace/app-dev' });
	await findByTestId('marketplace-roster');

	// No built-in team ships a human name, so every row is addressed by its role.
	// A name is something the admin gives an agent later, from its settings.
	const engineer = await findByTestId('roster-row-engineer');
	expect(engineer.textContent).toContain('Engineer');
	expect(engineer.textContent).not.toContain('Max');
	const architect = await findByTestId('roster-row-architect');
	expect(architect.textContent).toContain('Architect');
	expect(architect.textContent).not.toContain('Ada');

	// The row's avatar is drawn from the team's own `avatar_spec`, so it is a real
	// generated sprite rather than the initials fallback - the face still ships
	// even though the name does not.
	const img = engineer.querySelector('img');
	expect(img?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);

	// The Captain ships no avatar_spec either, so its row falls back to initials.
	const captain = await findByTestId('roster-row-captain');
	expect(captain.textContent).toContain('Captain');
	expect(captain.querySelector('img')).toBeNull();
});

test('Launch new project opens the standard create dialog preselected to the team', async () => {
	const { findByTestId, user } = await renderApp({
		initialPath: '/marketplace/app-dev',
	});
	await user.click(await findByTestId('marketplace-launch'));

	// The standard "New project" dialog opens (rendered into a portal on document.body)
	// with the marketplace team card already selected.
	await waitFor(() => {
		const card = document.body.querySelector('[data-testid="marketplace-team-card-app-dev"]');
		expect(card).toBeTruthy();
		expect(card?.getAttribute('aria-pressed')).toBe('true');
	});
});

test('arriving mid-hire preselects the project and defaults to picking roles', async () => {
	let projectSlug = '';
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const { db } = getTestContext();
			const team = (await (await createTestTeam(db, { name: 'Demo Team' })).json()).data;
			const project = (await (await createTestProject(db, team.id, { name: 'Storefront' })).json())
				.data;
			projectSlug = project.slug;
		},
	});
	// Enter the way the hire chooser sends you: the catalog, carrying the project
	// the hire was started from.
	await router.navigate({
		to: '/marketplace/$slug',
		params: { slug: 'app-dev' },
		search: { forProject: projectSlug },
	});
	await findByTestId('marketplace-detail');
	await findByTestId('hiring-for-banner');

	// Adding to the project you came from leads; launching a new project demotes
	// to secondary but stays reachable.
	const add = await findByTestId('marketplace-add-existing');
	expect(add.textContent).toContain('Add to Storefront');
	await user.click(add);

	const select = (await findByTestId('add-to-project-select')) as HTMLSelectElement;
	expect(select.value).toBe(projectSlug);

	// "Hire agent" is a request for a teammate, not a second roster, so the scope
	// starts on the role picker rather than on the whole team.
	const pickRoles = (await findByTestId('add-scope-pick-roles')) as HTMLInputElement;
	expect(pickRoles.checked).toBe(true);
	await findByTestId('add-role-picker');

	// Each role is offered by its role, face and all - the team ships no names.
	const securityEngineer = await findByTestId('add-role-security-engineer');
	const row = securityEngineer.closest('label');
	expect(row?.textContent).toContain('Security Engineer');
	expect(row?.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
});

test('Add to a project can add the whole team or a chosen subset of roles', async () => {
	let projectSlug = '';
	const { findByTestId, findByText, user, ctx } = await renderApp({
		initialPath: '/marketplace/app-dev',
		// A Blank team (Captain only), not seedWorkspace's 10-agent App Team: this
		// test just needs one project to appear in the dialog's dropdown, and this
		// file shares a shard with the asset suites, whose PGlite is already the
		// heaviest in the web tier.
		seed: async () => {
			const { db } = getTestContext();
			const team = (await (await createTestTeam(db, { name: 'Demo Team' })).json()).data;
			const project = (
				await (await createTestProject(db, team.id, { name: 'Demo Project' })).json()
			).data;
			projectSlug = project.slug;
		},
	});

	await user.click(await findByTestId('marketplace-add-existing'));

	// The dialog is portalled onto document.body.
	const dialogBody = document.body;
	await waitFor(() => {
		expect(dialogBody.querySelector('[data-testid="add-to-project-select"]')).toBeTruthy();
	});
	const select = dialogBody.querySelector(
		'[data-testid="add-to-project-select"]',
	) as HTMLSelectElement;
	await user.selectOptions(select, projectSlug);

	// Whole team is the default, and the role checkboxes are hidden until asked for.
	const wholeTeam = dialogBody.querySelector(
		'[data-testid="add-scope-whole-team"]',
	) as HTMLInputElement;
	expect(wholeTeam.checked).toBe(true);
	expect(dialogBody.querySelector('[data-testid="add-role-picker"]')).toBeNull();

	// Switch to picking roles: the roster appears, without the Captain.
	await user.click(dialogBody.querySelector('[data-testid="add-scope-pick-roles"]') as Element);
	await waitFor(() => {
		expect(dialogBody.querySelector('[data-testid="add-role-picker"]')).toBeTruthy();
	});
	expect(dialogBody.querySelector('[data-testid="add-role-captain"]')).toBeNull();
	expect(dialogBody.querySelector('[data-testid="add-role-security-engineer"]')).toBeTruthy();

	// Nothing picked yet, so there is nothing to submit.
	const submit = dialogBody.querySelector(
		'[data-testid="add-to-project-submit"]',
	) as HTMLButtonElement;
	expect(submit.disabled).toBe(true);

	await user.click(
		dialogBody.querySelector('[data-testid="add-role-security-engineer"]') as Element,
	);
	await user.click(dialogBody.querySelector('[data-testid="add-role-qa-engineer"]') as Element);
	await waitFor(() => expect(submit.textContent).toContain('Add 2 roles'));
	await user.click(submit);

	// The success toast names the count, and a CEO task was created carrying only
	// the chosen roles.
	await findByText(/The CEO is adding 2 roles from the App Team team/);
	await waitFor(async () => {
		const rows = await ctx.db.query<{ title: string; description: string; labels: string[] }>(
			`SELECT t.title, t.description, t.labels FROM tasks t
			 JOIN projects p ON p.id = t.project_id
			 WHERE p.slug = $1 AND t.labels::jsonb ? 'add-marketplace-roles'`,
			[projectSlug],
		);
		expect(rows.rows.length).toBe(1);
		expect(rows.rows[0].description).toContain('role="security-engineer"');
		expect(rows.rows[0].description).toContain('role="qa-engineer"');
		expect(rows.rows[0].description).not.toContain('role="engineer"');
	});
});

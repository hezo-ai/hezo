import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

test('marketplace list renders the available teams', async () => {
	const { findByTestId, findByText } = await renderApp({ initialPath: '/marketplace' });
	await findByTestId('marketplace-page');
	// The software-development team ("App Team") is served from the committed folder.
	await findByText('App Team');
	await findByTestId('marketplace-card-software-development');
});

test('marketplace detail shows the roster, version, and changelog with breadcrumbs', async () => {
	const { findByTestId, findByText, getAllByText } = await renderApp({
		initialPath: '/marketplace/software-development',
	});
	await findByTestId('marketplace-detail');
	// Breadcrumb back to the marketplace.
	await findByText('Marketplace');
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

test('Launch new project opens the standard create dialog preselected to the team', async () => {
	const { findByTestId, user } = await renderApp({
		initialPath: '/marketplace/software-development',
	});
	await user.click(await findByTestId('marketplace-launch'));

	// The standard "New project" dialog opens (rendered into a portal on document.body)
	// with the marketplace team card already selected.
	await waitFor(() => {
		const card = document.body.querySelector(
			'[data-testid="marketplace-team-card-software-development"]',
		);
		expect(card).toBeTruthy();
		expect(card?.getAttribute('aria-pressed')).toBe('true');
	});
});

test('Add to a project can add the whole team or a chosen subset of roles', async () => {
	let projectSlug = '';
	const { findByTestId, findByText, user, ctx } = await renderApp({
		initialPath: '/marketplace/software-development',
		seed: async () => {
			const ws = await seedWorkspace();
			projectSlug = ws.internalSlug;
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

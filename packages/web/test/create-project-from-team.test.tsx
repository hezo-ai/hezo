import { DEFAULT_TEAM_SLUG } from '@hezo/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

async function openNewProjectDialog() {
	let ws!: SeededWorkspace;
	const utils = await renderApp({
		initialPath: '/home',
		seed: async () => {
			ws = await seedWorkspace();
			await seedProject(ws, { name: 'Existing Project' });
			sessionStorage.setItem('hezo:activeTeamSlug', ws.team.slug);
		},
	});
	const section = await utils.findByTestId('home-projects', undefined, { timeout: 15_000 });
	await utils.user.click(within(section).getByTestId('home-new-project'));
	// The dialog opens on its entry step (name + description); the submit button is
	// gated behind a team selection now, so wait on the name field instead.
	await screen.findByPlaceholderText('e.g. Marketing Site');
	return { ...utils, ws };
}

test('the header close button dismisses the dialog (mobile has no Escape key)', async () => {
	const { user } = await openNewProjectDialog();
	await user.click(screen.getByRole('button', { name: 'Close' }));
	await waitFor(() => expect(screen.queryByPlaceholderText('e.g. Marketing Site')).toBeNull());
});

test('lists existing teams (not HQ) as cloneable sources and submits source_team_id', async () => {
	const { user, ws } = await openNewProjectDialog();

	// Name + description first (the fields live on the entry step).
	await user.type(screen.getByPlaceholderText('e.g. Marketing Site'), 'Cloned From Team');
	await user.type(
		screen.getByPlaceholderText(
			'What is this project? Domain, users, and the core problem it solves.',
		),
		'A project cloned from an existing team.',
	);

	// Existing teams to clone live on the "Copy existing team" tab of the full catalog.
	await user.click(screen.getByTestId('view-all-teams'));
	await user.click(await screen.findByTestId('team-tab-copy'));

	// The seeded project-team is offered as a source; the internal HQ team is not.
	const sourceCard = await screen.findByTestId(`source-team-card-${ws.team.slug}`);
	expect(screen.queryByTestId(`source-team-card-${DEFAULT_TEAM_SLUG}`)).toBeNull();

	// No action buttons until a team is picked.
	expect(screen.queryByTestId('create-project-submit')).toBeNull();

	// The card opens the team's detail — its live roster, and no action buttons,
	// because the browse screens are for picking, not submitting.
	await user.click(sourceCard);
	await screen.findByTestId('team-detail');
	expect(screen.queryByTestId('create-project-submit')).toBeNull();
	await user.click(screen.getByTestId('team-detail-select'));

	const submit = (await screen.findByTestId('create-project-submit')) as HTMLButtonElement;
	expect(submit.disabled).toBe(false);

	await user.click(submit);

	// The source-team path mints a fresh template named after the source team —
	// a signal the request carried source_team_id (the template path mints none).
	const { db } = getTestContext();
	await waitFor(async () => {
		// seedWorkspace names the source team "Demo Team".
		const minted = await db.query('SELECT 1 FROM team_templates WHERE name = $1', ['Demo Team']);
		expect(minted.rows.length).toBe(1);
	});
});

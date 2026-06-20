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
	await screen.findByTestId('create-project-submit');
	return { ...utils, ws };
}

test('lists existing teams (not HQ) as cloneable sources and submits source_team_id', async () => {
	const { user, ws } = await openNewProjectDialog();

	// The seeded project-team is offered as a source; the internal HQ team is not.
	const sourceCard = await screen.findByTestId(`source-team-card-${ws.team.slug}`);
	expect(screen.queryByTestId(`source-team-card-${DEFAULT_TEAM_SLUG}`)).toBeNull();

	const submit = screen.getByTestId('create-project-submit') as HTMLButtonElement;
	// Disabled until name + description + a source selection are all present.
	expect(submit.disabled).toBe(true);

	await user.type(screen.getByPlaceholderText('e.g. Marketing Site'), 'Cloned From Team');
	await user.type(
		screen.getByPlaceholderText(
			'What is this project? Domain, users, and the core problem it solves.',
		),
		'A project cloned from an existing team.',
	);
	// Still disabled with no source picked.
	expect(submit.disabled).toBe(true);

	await user.click(sourceCard);
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

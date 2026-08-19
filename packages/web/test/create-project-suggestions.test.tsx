import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

async function openDialogFromHome() {
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
	await utils.findByPlaceholderText('e.g. Marketing Site');
	return { ...utils, ws };
}

test('describing the project reveals ranked suggestions; picking one confirms it and shows the actions', async () => {
	const { user, findByText, findByPlaceholderText, findByTestId } = await openDialogFromHome();

	// Empty state: a prompt, no cards, no action buttons.
	await findByText('Describe your project above to see suggested teams.');
	expect(screen.queryByTestId('create-project-submit')).toBeNull();

	// A brief that overwhelmingly matches the Influencer Marketing team, so it ranks
	// first and stays first once the marketplace catalog loads.
	await user.type(
		await findByPlaceholderText(/What is this project/),
		'Social media influencer marketing to grow brand reach with content and audience.',
	);

	// The prompt gives way to ranked suggestion cards.
	await waitFor(() =>
		expect(screen.queryByText('Describe your project above to see suggested teams.')).toBeNull(),
	);
	const topSuggestion = await findByTestId('marketplace-team-card-influencer', undefined, {
		timeout: 15_000,
	});

	// Picking a suggestion collapses to the confirmation card and reveals both actions.
	await user.click(topSuggestion);
	await findByTestId('selected-team-card');
	await findByTestId('choose-different-team');
	await findByTestId('create-project-submit');
	await findByTestId('plan-with-ceo-submit');
});

test('a brief matching no team suggests Blank, not the first two catalog entries', async () => {
	const { user, findByPlaceholderText, findByTestId } = await openDialogFromHome();

	// The reported bug, verbatim. Nothing in any team's keywords or name says
	// "translations" or "workflow", so the old `newOptions.slice(0, 2)` fallback
	// offered Social Media Marketing and Investment Portfolio - whatever sorted
	// first - under a heading that reads as "these match".
	await user.type(await findByPlaceholderText('e.g. Marketing Site'), 'translations workflow');
	await user.type(
		await findByPlaceholderText(/What is this project/),
		'we need a workflow for doing translations',
	);

	await waitFor(() =>
		expect(screen.queryByText('Describe your project above to see suggested teams.')).toBeNull(),
	);
	await findByTestId('team-type-card-Blank', undefined, { timeout: 15_000 });

	// And none of the marketplace teams are put forward as a match.
	await waitFor(() => {
		expect(screen.queryByTestId('marketplace-team-card-influencer')).toBeNull();
		expect(screen.queryByTestId('marketplace-team-card-investment')).toBeNull();
		expect(screen.queryByTestId('marketplace-team-card-app-dev')).toBeNull();
	});
});

test('View all teams opens the tabbed catalog with search; Back preserves the entry fields', async () => {
	const { user, findByPlaceholderText, findByTestId, ws } = await openDialogFromHome();

	const nameInput = (await findByPlaceholderText('e.g. Marketing Site')) as HTMLInputElement;
	await user.type(nameInput, 'Keep My Name');

	await user.click(await findByTestId('view-all-teams'));

	// Both tabs render because there is an existing team to copy.
	await findByTestId('team-tab-new');
	await findByTestId('team-tab-copy');
	// The New-team tab lists the seeded templates.
	await findByTestId('team-type-card-Blank');
	await findByTestId('team-type-card-App Team');

	// Search filters the active tab: "blank" keeps Blank, drops App Team.
	await user.type(await findByTestId('team-search'), 'blank');
	await findByTestId('team-type-card-Blank');
	await waitFor(() => expect(screen.queryByTestId('team-type-card-App Team')).toBeNull());

	// Clear + switch to the Copy tab: the source team shows, templates do not.
	await user.clear(await findByTestId('team-search'));
	await user.click(await findByTestId('team-tab-copy'));
	await findByTestId(`source-team-card-${ws.team.slug}`);
	await waitFor(() => expect(screen.queryByTestId('team-type-card-Blank')).toBeNull());

	// Back returns to the entry step with the typed name intact.
	await user.click(await findByTestId('all-teams-back'));
	const restored = (await findByPlaceholderText('e.g. Marketing Site')) as HTMLInputElement;
	expect(restored.value).toBe('Keep My Name');
});

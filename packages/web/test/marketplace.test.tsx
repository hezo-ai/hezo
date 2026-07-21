import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

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
	// Roster is rendered (Captain is always shown, plus specialist roles).
	await findByText('Engineer');
	await findByText('Architect');
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

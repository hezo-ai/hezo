import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

test('marketplace list renders the available teams', async () => {
	const { findByTestId, findByText } = await renderApp({ initialPath: '/marketplace' });
	await findByTestId('marketplace-page');
	// The software-development team ("Startup") is served from the committed folder.
	await findByText('Startup');
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

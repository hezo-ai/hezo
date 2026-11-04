import { resetRuntimeConfig, setPolicy } from '@hezo/server/src/config/runtime';
import { HQ_PROJECT_SLUG, SandboxBackend } from '@hezo/shared';
import { afterEach, expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// A deployment's hours allowance can be part plan, part bought. The plan's share
// comes back each period and the bought share carries over until it is used, so
// HQ's Hours tab names the two apart instead of promising the whole total back.
// The allowance card renders only where hours are billed, hence the remote backend.

const MANAGE_URL = 'https://control.example/account#billing';

afterEach(() => {
	resetRuntimeConfig();
});

async function openHqHours(pinned: {
	monthlyContainerHours: number;
	purchasedContainerHours?: number;
}) {
	const app = await renderApp({
		initialPath: '/',
		seed: () => {
			setPolicy({
				managedBy: 'Acme Cloud',
				manageUrl: MANAGE_URL,
				pinned: { ...pinned, backend: SandboxBackend.Daytona },
			});
		},
	});
	await app.router.navigate({
		to: '/projects/$projectId/budget/hours',
		params: { projectId: HQ_PROJECT_SLUG },
	});
	return app;
}

test('an allowance with bought hours names the per-period share and the hours that carry over', async () => {
	const { findByTestId } = await openHqHours({
		monthlyContainerHours: 30,
		purchasedContainerHours: 20,
	});

	const card = await findByTestId('monthly-hours-cap-value');
	expect(card.textContent).toBe(
		'10 container hours each period, plus 20 bought hours that carry over until used.',
	);

	const remaining = await findByTestId('container-hours-remaining');
	expect(remaining.textContent).toMatch(
		/^30\.0 h left\. 10 h come back on .+, and bought hours carry over until used\. Buy more hours$/,
	);
	expect((await findByTestId('container-hours-buy')).getAttribute('href')).toBe(MANAGE_URL);
});

test('an allowance with no bought hours keeps the per-period sentence and the reset date', async () => {
	const { findByTestId } = await openHqHours({ monthlyContainerHours: 10 });

	const card = await findByTestId('monthly-hours-cap-value');
	expect(card.textContent).toBe('10 container hours each period.');

	const remaining = await findByTestId('container-hours-remaining');
	expect(remaining.textContent).toMatch(/^10\.0 h left\. Resets .+\. Buy more hours$/);
});

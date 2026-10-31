import { resetRuntimeConfig, setPolicy } from '@hezo/server/src/config/runtime';
import { setMonthlyContainerHours } from '@hezo/server/src/lib/system-meta';
import { seedMonthToDateSeconds } from '@hezo/server/test/helpers/uptime';
import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { afterEach, expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// The allowance card on HQ's Hours tab names when the hours reset. Where the
// deployment fixed the allowance, it also links out to where more are bought,
// beside that date - the one way to more hours before it comes round.

const MANAGE_URL = 'https://control.example/account#billing';

afterEach(() => {
	resetRuntimeConfig();
});

async function openHqHours(seed: Parameters<typeof renderApp>[0]['seed']) {
	const app = await renderApp({ initialPath: '/', seed });
	await app.router.navigate({
		to: '/projects/$projectId/budget/hours',
		params: { projectId: HQ_PROJECT_SLUG },
	});
	return app;
}

test('a spent allowance the deployment fixed links to buying more hours beside the reset date', async () => {
	const { findByTestId } = await openHqHours(async (ctx) => {
		setPolicy({
			managedBy: 'Acme Cloud',
			manageUrl: MANAGE_URL,
			pinned: { monthlyContainerHours: 10 },
		});
		await seedMonthToDateSeconds(ctx.db, 10 * 3600 + 180);
	});

	const remaining = await findByTestId('container-hours-remaining');
	expect(remaining.textContent).toMatch(/^0\.0 h left\. Resets .+\. Buy more hours$/);

	const link = await findByTestId('container-hours-buy');
	expect(remaining.contains(link)).toBe(true);
	expect(link.getAttribute('href')).toBe(MANAGE_URL);
	expect(link.getAttribute('target')).toBe('_blank');
	expect(link.getAttribute('rel')).toBe('noopener noreferrer');
});

test('an allowance the operator set carries no link, since the control on the page moves it', async () => {
	const { findByTestId, queryByTestId } = await openHqHours(async (ctx) => {
		setPolicy({ managedBy: 'Acme Cloud', manageUrl: MANAGE_URL, pinned: {} });
		await setMonthlyContainerHours(ctx.db, 10);
	});

	const remaining = await findByTestId('container-hours-remaining');
	expect(remaining.textContent).toMatch(/^10\.0 h left\. Resets .+\.$/);
	expect(queryByTestId('container-hours-buy')).toBeNull();
});

test('an instance nobody manages has nowhere to buy hours, so no link', async () => {
	const { findByTestId, queryByTestId } = await openHqHours(async (ctx) => {
		await setMonthlyContainerHours(ctx.db, 10);
	});

	const remaining = await findByTestId('container-hours-remaining');
	expect(remaining.textContent).toMatch(/^10\.0 h left\. Resets .+\.$/);
	expect(queryByTestId('container-hours-buy')).toBeNull();
});

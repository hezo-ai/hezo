import { resetRuntimeConfig, setPolicy } from '@hezo/server/src/config/runtime';
import { HQ_PROJECT_SLUG } from '@hezo/shared';
import { afterEach, expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// A deployment that fixes an instance's hours puts a row beside its plan that
// opens HQ's Hours tab: the one view of every project's hours, which nothing
// else in Settings points to. Superuser-only, like that view.

function managed(): void {
	setPolicy({
		managedBy: 'Acme Cloud',
		manageUrl: 'https://control.example/plan',
		pinned: { monthlyContainerHours: 10 },
	});
}

afterEach(() => {
	resetRuntimeConfig();
});

test('a superuser on a managed instance gets a row beside the plan that opens every project’s hours', async () => {
	const { findAllByTestId, router } = await renderApp({
		initialPath: '/settings',
		seed: () => managed(),
	});

	const [row] = await findAllByTestId('settings-hours-by-project');
	expect(row?.textContent).toBe('Hours by project');
	expect(row?.getAttribute('href')).toBe(`/projects/${HQ_PROJECT_SLUG}/budget/hours`);
	// Beside the plan, in the deployer's own group.
	const [group] = await findAllByTestId('settings-policy-group');
	expect(group?.contains(row ?? null)).toBe(true);

	row?.click();
	await expect
		.poll(() => router.state.location.pathname)
		.toBe(`/projects/${HQ_PROJECT_SLUG}/budget/hours`);
});

test('a non-superuser gets no row for a view they cannot open', async () => {
	const { findAllByTestId, queryAllByTestId } = await renderApp({
		initialPath: '/settings',
		seed: async (ctx) => {
			managed();
			await ctx.db.query('UPDATE users SET is_superuser = false');
		},
	});

	await findAllByTestId('settings-policy-link');
	expect(queryAllByTestId('settings-hours-by-project')).toHaveLength(0);
});

test('an instance nobody manages has no group to put it in', async () => {
	const { findByText, queryAllByTestId } = await renderApp({ initialPath: '/settings' });

	await findByText('Appearance');
	expect(queryAllByTestId('settings-policy-group')).toHaveLength(0);
	expect(queryAllByTestId('settings-hours-by-project')).toHaveLength(0);
});

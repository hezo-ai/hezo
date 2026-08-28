// The inbox toolbar is viewport-conditional: below 640px the read filter, the
// sort and "Mark all as read" are not rendered at all, and open in a dialog
// behind a trigger instead. happy-dom reports a fixed 1024px viewport and
// cannot run the media query, so only real Chromium at a real width can see
// which branch mounted. Row ordering itself is covered in the component tier by
// packages/web/test/inbox-sort.test.tsx.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

test.describe('inbox filters - mobile (390px)', () => {
	test('the toolbar collapses to search plus a trigger, and the dialog holds the rest', async ({
		page,
		freshWorkspace,
	}) => {
		await page.goto(`/projects/${freshWorkspace.projectSlug}/inbox`);
		await waitForPageLoad(page);

		// Search keeps the row; everything else has moved behind the trigger.
		await expect(page.getByLabel('Search inbox')).toBeVisible({ timeout: 20_000 });
		const trigger = page.getByTestId('inbox-filter-trigger');
		await expect(trigger).toBeVisible();

		// The desktop branch is absent from the DOM, not merely hidden - two copies
		// would put every filter label on the page twice.
		await expect(page.getByRole('group', { name: 'Show' })).toHaveCount(0);
		await expect(page.getByRole('group', { name: 'Sort' })).toHaveCount(0);

		await trigger.click();
		const dialog = page.getByTestId('inbox-filter-dialog');
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('group', { name: 'Show' })).toBeVisible();
		await expect(dialog.getByRole('group', { name: 'Sort' })).toBeVisible();
		await expect(dialog.getByTestId('inbox-mark-all-read')).toBeVisible();
	});

	test('picking Oldest in the dialog writes the URL and badges the trigger', async ({
		page,
		freshWorkspace,
	}) => {
		await page.goto(`/projects/${freshWorkspace.projectSlug}/inbox`);
		await waitForPageLoad(page);

		const trigger = page.getByTestId('inbox-filter-trigger');
		await expect(trigger).toBeVisible({ timeout: 20_000 });
		// Nothing is off its default yet, so there is no count to show.
		await expect(page.getByTestId('inbox-filter-count')).toHaveCount(0);

		await trigger.click();
		const dialog = page.getByTestId('inbox-filter-dialog');
		await dialog.getByRole('group', { name: 'Sort' }).getByText('Oldest').click();

		await expect(page).toHaveURL(/[?&]sort=oldest/);
		// The dialog stays open: filter and sort are usually set together.
		await expect(dialog).toBeVisible();

		await page.getByTestId('dialog-close').click();
		await expect(dialog).toHaveCount(0);
		// One control off its default, so the trigger says so.
		await expect(page.getByTestId('inbox-filter-count')).toHaveText('1');

		// Back to the default and the param leaves the URL again.
		await trigger.click();
		await dialog.getByRole('group', { name: 'Sort' }).getByText('Newest').click();
		await expect(page).not.toHaveURL(/[?&]sort=/);
	});

	test('the global inbox collapses the same way', async ({ page, freshWorkspace }) => {
		void freshWorkspace;
		await page.goto('/home/inbox');
		await waitForPageLoad(page);

		await expect(page.getByTestId('inbox-filter-trigger')).toBeVisible({ timeout: 20_000 });
		await expect(page.getByRole('group', { name: 'Sort' })).toHaveCount(0);
	});

	test('at desktop width the pills are inline and the trigger is gone', async ({
		page,
		freshWorkspace,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.goto(`/projects/${freshWorkspace.projectSlug}/inbox`);
		await waitForPageLoad(page);

		await expect(page.getByRole('group', { name: 'Show' })).toBeVisible({ timeout: 20_000 });
		await expect(page.getByRole('group', { name: 'Sort' })).toBeVisible();
		await expect(page.getByTestId('inbox-mark-all-read')).toBeVisible();
		await expect(page.getByTestId('inbox-filter-trigger')).toHaveCount(0);
	});
});

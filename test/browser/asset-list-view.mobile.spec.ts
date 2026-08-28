import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, waitForPageLoad } from './helpers';

// Criterion #2 (viewport-conditional behaviour). Three things about the assets
// library only exist at a real mobile width: the toolbar's filter and sort are
// not rendered at all below `md` and open in a dialog behind a trigger instead;
// the list view's Type, Size and Modified columns are dropped by a media query
// and reappear as a line under the filename; and both header actions have to
// survive the narrow row. happy-dom reports a fixed 1024px viewport and cannot
// run the media query, so only real Chromium at 390px can see which branch
// mounted. Ordering, the toggle and header sorting are covered in the component
// tier by packages/web/test/asset-list-view.test.tsx.

type CreatedProject = { id: string; slug: string; team_id: string };

const PNG_BYTES = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
]);

async function createProjectWithAssets(page: Page, token: string, name: string) {
	const projectRes = await createProjectAndClearPlanning(page, '', token, {
		name,
		description: 'Asset list view mobile test.',
	});
	const project = ((await projectRes.json()) as { data: CreatedProject }).data;

	for (const filename of ['shot.png', 'rows.csv']) {
		const uploadRes = await page.request.post(`/api/projects/${project.slug}/assets`, {
			headers: { Authorization: `Bearer ${token}` },
			multipart: {
				file: {
					name: filename,
					mimeType: filename.endsWith('.png') ? 'image/png' : 'text/plain',
					buffer: filename.endsWith('.png') ? PNG_BYTES : Buffer.from('a,b\n1,2\n'),
				},
			},
		});
		if (!uploadRes.ok()) throw new Error(`asset upload failed: ${uploadRes.status()}`);
	}

	return { project };
}

test.describe('Assets list view — mobile layout (390px)', () => {
	test('the toolbar collapses to a trigger, and the dialog holds filter and sort', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { project } = await createProjectWithAssets(page, token, 'Mobile Asset List');

		await page.goto(`/projects/${project.slug}/assets`);
		await waitForPageLoad(page);

		const trigger = page.getByTestId('asset-filter-trigger');
		await expect(trigger).toBeVisible({ timeout: 20_000 });

		// The desktop branch is absent from the DOM, not merely hidden - two copies
		// would put every filter and sort label on the page twice.
		await expect(page.getByTestId('asset-filter-button')).toHaveCount(0);
		await expect(page.getByTestId('asset-sort-button')).toHaveCount(0);

		// Both header actions survive the narrow row; New folder keeps its
		// accessible name after dropping its label.
		await expect(page.getByTestId('asset-new-folder-button')).toBeVisible();
		await expect(page.getByTestId('asset-upload-button')).toBeVisible();
		await expect(page.getByRole('button', { name: 'New folder' })).toBeVisible();

		// The view toggle stays on the row: switching layout is one tap, not two.
		await expect(page.getByTestId('asset-view-toggle')).toBeVisible();

		await trigger.click();
		const dialog = page.getByTestId('asset-filter-dialog');
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('group', { name: 'Show' })).toBeVisible();
		await expect(dialog.getByRole('group', { name: 'Sort by' })).toBeVisible();
		await expect(dialog.getByRole('group', { name: 'Order' })).toBeVisible();
	});

	test('the dialog writes the URL, badges the trigger and stays open', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { project } = await createProjectWithAssets(page, token, 'Mobile Asset Filters');

		await page.goto(`/projects/${project.slug}/assets`);
		await waitForPageLoad(page);

		const trigger = page.getByTestId('asset-filter-trigger');
		await expect(trigger).toBeVisible({ timeout: 20_000 });
		// Nothing is off its default yet, so there is no count to show.
		await expect(page.getByTestId('asset-filter-count')).toHaveCount(0);

		await trigger.click();
		const dialog = page.getByTestId('asset-filter-dialog');
		// Column and direction are set separately here, and together name the same
		// order a desktop column header would reach.
		await dialog.getByRole('group', { name: 'Sort by' }).getByText('Size').click();
		await expect(page).toHaveURL(/[?&]sort=size_desc/);
		await dialog.getByRole('group', { name: 'Order' }).getByText('Smallest').click();
		await expect(page).toHaveURL(/[?&]sort=size_asc/);

		// The dialog stays open: filter and sort are usually set together.
		await expect(dialog).toBeVisible();
		await dialog.getByRole('group', { name: 'Show' }).getByText('Archived').click();
		await expect(page).toHaveURL(/[?&]filter=archived/);

		await page.getByTestId('dialog-close').click();
		await expect(dialog).toHaveCount(0);
		// Both controls are off their defaults, so the trigger says so.
		await expect(page.getByTestId('asset-filter-count')).toHaveText('2');
	});

	test('list rows drop to one column and carry their type, size and date inline', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { project } = await createProjectWithAssets(page, token, 'Mobile Asset Columns');

		await page.goto(`/projects/${project.slug}/assets?view=list`);
		await waitForPageLoad(page);

		const row = page.locator('#asset-row-rows\\.csv');
		await expect(row).toBeVisible({ timeout: 20_000 });

		// The three trailing columns are laid out away, header included, so the row
		// is the filename plus one meta line. Addressed as raw `td`s rather than by
		// role: a `display: none` cell is out of the accessibility tree entirely, so
		// `getByRole('cell')` would skip straight past the ones under test.
		await expect(page.getByRole('columnheader', { name: /Size/ })).toBeHidden();
		for (const column of [1, 2, 3]) {
			await expect(row.locator('td').nth(column)).toBeHidden();
		}

		// Nothing is lost: what those columns said now sits under the filename.
		await expect(row).toContainText('CSV');
		await expect(row).toContainText('rows.csv');

		// And the row still fits - a horizontally scrolling library is the defect
		// this layout exists to avoid.
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
		);
		expect(overflow).toBeLessThanOrEqual(1);
	});
});

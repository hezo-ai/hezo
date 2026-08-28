import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, waitForPageLoad } from './helpers';

// Criterion #2 (viewport- and pointer-conditional behaviour): the list's row
// actions are laid out at zero opacity on a device that has hover, and only a
// real pointer entering a real row brings them back. happy-dom applies no CSS
// and has no pointer, so the component tier can see that the buttons exist but
// never that they are reachable. Ordering, sorting and the toggle are covered
// there instead, in packages/web/test/asset-list-view.test.tsx.

type CreatedProject = { id: string; slug: string; team_id: string };

async function createProjectWithAsset(page: Page, token: string, name: string) {
	const projectRes = await createProjectAndClearPlanning(page, '', token, {
		name,
		description: 'Asset list view desktop test.',
	});
	const project = ((await projectRes.json()) as { data: CreatedProject }).data;

	const uploadRes = await page.request.post(`/api/projects/${project.slug}/assets`, {
		headers: { Authorization: `Bearer ${token}` },
		multipart: {
			file: { name: 'rows.csv', mimeType: 'text/plain', buffer: Buffer.from('a,b\n1,2\n') },
		},
	});
	if (!uploadRes.ok()) throw new Error(`asset upload failed: ${uploadRes.status()}`);

	return { project };
}

test.describe('Assets list view', () => {
	test('row actions are hidden until the row is hovered, then usable', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { project } = await createProjectWithAsset(page, token, 'Desktop Asset List');

		await page.goto(`/projects/${project.slug}/assets?view=list`);
		await waitForPageLoad(page);

		const row = page.locator('#asset-row-rows\\.csv');
		await expect(row).toBeVisible({ timeout: 20_000 });
		const archive = row.getByTestId('asset-archive');

		const opacity = () =>
			row.getByTestId('asset-row-actions').evaluate((el) => getComputedStyle(el).opacity);

		// At rest the actions take up their space but paint nothing, so a long
		// library reads as filenames rather than as a wall of icons.
		expect(await opacity()).toBe('0');

		await row.hover();
		await expect.poll(opacity).toBe('1');

		// And they still do what they say once revealed.
		await archive.click();
		await expect(page.getByTestId('asset-filter-text')).toHaveText('Showing active items');
		await expect(row).toHaveCount(0);
	});
});

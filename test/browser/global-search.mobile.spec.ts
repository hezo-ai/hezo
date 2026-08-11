import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, waitForPageLoad } from './helpers';

// Criterion #2 (viewport-conditional behavior): the search palette is a
// full-screen dialog below `sm`, so its five type tabs have roughly 343px to
// live in. Whether they stay readable depends on a real layout pass — the strip
// scrolling rather than compressing its tabs — which happy-dom cannot measure
// (every box is 0). The `mobile` Playwright project runs *.mobile.spec.ts at 390px.

type CreatedProject = { id: string; slug: string; team_id: string };

test.describe('Global search palette — mobile layout (390px)', () => {
	test('all five type tabs stay reachable in a scrollable strip', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const projectRes = await createProjectAndClearPlanning(page, '', token, {
			name: 'Mobile Search',
			description: 'Global search mobile test.',
		});
		const project = ((await projectRes.json()) as { data: CreatedProject }).data;

		// Seed one hit of every type that a project can own, all sharing a term.
		const auth = { Authorization: `Bearer ${token}` };
		const term = 'zebra';
		await page.request.post(`/api/projects/${project.slug}/tasks`, {
			headers: auth,
			data: { project_id: project.id, title: `Zebra rollout`, description: `${term} plan` },
		});
		await page.request.post(`/api/projects/${project.slug}/assets`, {
			headers: auth,
			multipart: {
				file: {
					name: 'zebra-notes.md',
					mimeType: 'text/markdown',
					buffer: Buffer.from(`# ${term}\n\nField notes.`),
				},
			},
		});

		await page.goto('/home');
		await waitForPageLoad(page);

		await page.getByTestId('app-header-search').click();
		await page.getByTestId('global-search-input').fill(term);

		const assetTab = page.getByTestId('search-tab-asset');
		await expect(assetTab).toBeVisible({ timeout: 20000 });

		// The strip must scroll, not squash: each tab keeps a legible width even
		// when the row as a whole overflows the phone-width dialog.
		const strip = page.locator('[role="tablist"]').first();
		const box = await strip.boundingBox();
		expect(box).not.toBeNull();
		expect(box?.width).toBeLessThanOrEqual(390);
		for (const tab of await page.locator('[role="tab"]').all()) {
			const tabBox = await tab.boundingBox();
			expect(tabBox?.width ?? 0).toBeGreaterThan(40);
		}

		// The last tab is reachable by scrolling the strip, and selecting an asset
		// hit navigates to the asset viewer.
		await assetTab.scrollIntoViewIfNeeded();
		await assetTab.click();
		await page.getByTestId('search-result-asset').first().click();
		await expect(page).toHaveURL(/\/assets\/view\?file=/);
	});
});

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, waitForPageLoad } from './helpers';

// Criterion #2 (viewport-conditional behavior): the asset viewer's review
// panel only becomes a chevron-toggled slide-in drawer below `lg`, and the
// slide/scrim mechanics need a real layout pass at a mobile width — the
// `mobile` Playwright project runs *.mobile.spec.ts at 390px.

type CreatedProject = { id: string; slug: string; team_id: string };

const PNG_BYTES = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
]);

async function createProjectWithAsset(page: Page, token: string, name: string) {
	const projectRes = await createProjectAndClearPlanning(page, '', token, {
		name,
		description: 'Asset viewer mobile test.',
	});
	const project = ((await projectRes.json()) as { data: CreatedProject }).data;

	const uploadRes = await page.request.post(`/api/projects/${project.slug}/assets`, {
		headers: { Authorization: `Bearer ${token}` },
		multipart: {
			file: { name: 'shot.png', mimeType: 'image/png', buffer: PNG_BYTES },
		},
	});
	if (!uploadRes.ok()) throw new Error(`asset upload failed: ${uploadRes.status()}`);

	return { project };
}

test.describe('Asset viewer — mobile layout (390px)', () => {
	test('review panel is a collapsed drawer; the chevron opens it and comments post from it', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { project } = await createProjectWithAsset(page, token, 'Mobile Asset Viewer');

		await page.goto(`/projects/${project.slug}/assets/view?file=shot.png`);
		await waitForPageLoad(page);

		await expect(page.getByTestId('asset-viewer-image')).toBeVisible({ timeout: 20000 });

		const toggle = page.getByTestId('asset-review-toggle');
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');

		// Collapsed by default: the drawer is translated off the right edge, so its
		// left edge sits at (or beyond) the 390px viewport width.
		const drawer = page.getByTestId('asset-review-drawer');
		const closedBox = await drawer.boundingBox();
		expect(closedBox).not.toBeNull();
		expect(closedBox?.x ?? 0).toBeGreaterThanOrEqual(360);

		// Tapping the chevron slides the drawer into view.
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');
		await expect
			.poll(async () => (await drawer.boundingBox())?.x ?? 999, { timeout: 5000 })
			.toBeLessThan(200);
		await expect(page.getByTestId('asset-review-panel')).toBeInViewport();

		// The drawer is fully usable: leave a whole-asset comment on the image.
		await page.getByTestId('asset-review-composer-open').click();
		await page.getByTestId('asset-review-composer').fill('Logo looks off-center on mobile');
		await page.getByTestId('asset-review-composer-save').click();
		const row = page.getByTestId('asset-review-row');
		await expect(row).toBeVisible();
		await expect(row).toContainText('Whole asset');
		await expect(row).toContainText('Logo looks off-center on mobile');

		// The scrim tap collapses it again — tap left of the 300px drawer, where
		// the scrim is actually exposed (its center is covered by the drawer).
		await page
			.getByRole('button', { name: 'Close review comments' })
			.click({ position: { x: 20, y: 300 } });
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
		await expect
			.poll(async () => (await drawer.boundingBox())?.x ?? 0, { timeout: 5000 })
			.toBeGreaterThanOrEqual(360);
	});
});

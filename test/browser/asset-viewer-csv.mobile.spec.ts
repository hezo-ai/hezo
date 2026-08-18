import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, waitForPageLoad } from './helpers';

// Criterion #1 (real CSS layout) plus #2 (viewport-conditional): a CSV wider
// than the viewport has to scroll inside its own container while the page keeps
// a single vertical axis, and its free-text column has to wrap rather than
// stretch. Both are `scrollWidth`/`boundingBox` facts happy-dom cannot produce,
// and the width that matters is the narrowest one - the `mobile` Playwright
// project runs *.mobile.spec.ts at 390px.

type CreatedProject = { id: string; slug: string; team_id: string };

const LONG_CELL =
	'Orchestration that loses what the previous layer swore it saved is not a model problem - it is a memory problem.';

const CSV = [
	'original_tweet_url,reply_text,topic_category,why_this_reply,priority',
	`https://x.com/Vettan0/status/2089325568185495938,"${LONG_CELL}",agent-orchestration,"Re-verified live (~22 likes).",high`,
	'https://x.com/themahis/status/2088981603842179076,"Handoffs carry ownership, not vibes.",agent-orchestration,"Re-verified live (~338 likes).",high',
].join('\n');

async function createProjectWithCsv(page: Page, token: string, name: string) {
	const projectRes = await createProjectAndClearPlanning(page, '', token, {
		name,
		description: 'CSV asset viewer mobile test.',
	});
	const project = ((await projectRes.json()) as { data: CreatedProject }).data;

	const uploadRes = await page.request.post(`/api/projects/${project.slug}/assets`, {
		headers: { Authorization: `Bearer ${token}` },
		multipart: {
			file: { name: 'x-replies.csv', mimeType: 'text/plain', buffer: Buffer.from(CSV, 'utf8') },
		},
	});
	if (!uploadRes.ok()) throw new Error(`asset upload failed: ${uploadRes.status()}`);

	return { project };
}

test.describe('CSV asset viewer — mobile layout (390px)', () => {
	test('the table scrolls inside its own box and wraps its free-text column', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { project } = await createProjectWithCsv(page, token, 'Mobile CSV Viewer');

		await page.goto(`/projects/${project.slug}/assets/view?file=x-replies.csv`);
		await waitForPageLoad(page);

		const table = page.getByTestId('asset-csv-table');
		await expect(table).toBeVisible({ timeout: 20000 });

		// The container is the only thing that scrolls sideways: it is narrower
		// than its content, and no wider than the viewport.
		const box = await table.boundingBox();
		expect(box?.width ?? 0).toBeLessThanOrEqual(390);
		const overflows = await table.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
		expect(overflows).toBe(true);

		// The page itself keeps one axis - a table that stretched the layout would
		// show up here as a horizontally scrollable document.
		const pageScroll = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth,
		}));
		expect(pageScroll.scrollWidth).toBeLessThanOrEqual(pageScroll.clientWidth + 1);

		// The long free-text cell wraps into a column instead of running the table
		// off to one enormous width.
		const longCell = page.locator('td', { hasText: 'it is a memory problem' }).first();
		const cellBox = await longCell.boundingBox();
		expect(cellBox?.width ?? 0).toBeLessThanOrEqual(560);
		expect(cellBox?.height ?? 0).toBeGreaterThan(40);

		// Scrolling the container reaches the last column without moving the page.
		await table.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
		await expect(table.getByRole('columnheader', { name: 'priority' })).toBeInViewport();
	});
});

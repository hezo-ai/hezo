import { expect, test } from './fixtures';
import {
	authenticate,
	createProjectAndClearPlanning,
	uniqueName,
	waitForPageLoad,
} from './helpers';

// Playwright tier (rule 4): infinite-scroll auto-load is driven by an
// IntersectionObserver sentinel that only fires against a real layout engine +
// scroll — the component-test harness stubs IntersectionObserver, so this slice
// has to run in a real browser.
test.describe('Task list — infinite scroll', () => {
	test('loads further pages as the bottom sentinel scrolls into view', async ({
		page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projectRes = await createProjectAndClearPlanning(page, '', token, {
			name: uniqueName('Infinite Scroll'),
			description: 'E2E infinite scroll.',
		});
		const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

		// Seed more than one page worth of backlog tasks (default per_page is 50).
		const TOTAL = 60;
		for (let batch = 0; batch < TOTAL; batch += 10) {
			await Promise.all(
				Array.from({ length: Math.min(10, TOTAL - batch) }, (_, i) =>
					page.request.post(`/api/projects/${project.slug}/tasks`, {
						headers,
						data: {
							project_id: project.id,
							title: `Scroll Task ${String(batch + i + 1).padStart(3, '0')}`,
						},
					}),
				),
			);
		}

		await authenticate(page);
		await page.goto(`/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);

		// First page only: the count caps at the page size and "Load more" shows.
		const count = page.getByTestId('task-list-count');
		await expect(count).toContainText('Showing 50 of', { timeout: 20_000 });
		await expect(page.getByTestId('task-list-load-more')).toBeVisible();

		const before = (await count.textContent())?.match(/Showing (\d+) of (\d+)/);
		expect(before).toBeTruthy();
		expect(Number(before![1])).toBe(50);
		expect(Number(before![2])).toBeGreaterThan(50);

		// Scrolling the bottom sentinel into view auto-fetches the remaining pages.
		const main = page.locator('main').first();
		await expect(async () => {
			await main.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
			const text = (await count.textContent()) ?? '';
			const m = text.match(/Showing (\d+) of (\d+)/);
			expect(m).toBeTruthy();
			// Every matching task is loaded (shown === total) once scrolling is done.
			expect(m![1]).toBe(m![2]);
		}).toPass({ timeout: 20_000 });

		// With nothing left to fetch, the "Load more" affordance is gone.
		await expect(page.getByTestId('task-list-load-more')).toHaveCount(0);
	});
});

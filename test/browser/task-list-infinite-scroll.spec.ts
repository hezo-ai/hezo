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

		// Every task needs an assignee (createTask rejects otherwise), and the only
		// agent on a Blank project is the Captain. Disable it first so it doesn't
		// pick up and churn the seeded tasks out of the backlog filter (test runs
		// use fake Docker, so agent runs would otherwise fire instantly) — this
		// keeps the list deterministic.
		const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
		const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
		const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];
		await page.request.post(`/api/projects/${project.slug}/agents/${captain.id}/disable`, {
			headers,
		});

		// Seed more than one page worth of backlog tasks (default per_page is 50).
		// Sequentially — per-project ticket numbering is not safe under concurrent
		// inserts.
		const TOTAL = 60;
		for (let i = 1; i <= TOTAL; i++) {
			const res = await page.request.post(`/api/projects/${project.slug}/tasks`, {
				headers,
				data: {
					project_id: project.id,
					title: `Scroll Task ${String(i).padStart(3, '0')}`,
					assignee_id: captain.id,
				},
			});
			expect(res.ok()).toBeTruthy();
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
		// scrollIntoViewIfNeeded scrolls whichever ancestor is scrollable, so this
		// works without assuming which element owns the scroll.
		const sentinel = page.getByTestId('task-list-sentinel');
		await expect(async () => {
			await sentinel.scrollIntoViewIfNeeded();
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

import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

test.describe('Project task list — progress header (mobile)', () => {
	test('shows the segmented progress bar after planning is closed', async ({
		page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projectRes = await createProjectAndClearPlanning(page, '', token, {
			name: uniqueName('Progress Bar'),
			description: 'E2E progress bar.',
		});
		const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

		const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
		const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
		const assigneeId = (agents.find((a) => a.slug === 'engineer') ?? agents[0]).id;

		const doneRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
			headers,
			data: {
				project_id: project.id,
				title: 'Done task',
				assignee_id: assigneeId,
			},
		});
		const doneTask = ((await doneRes.json()) as { data: { id: string } }).data;
		await page.request.patch(`/api/projects/${project.slug}/tasks/${doneTask.id}`, {
			headers,
			data: { status: 'done' },
		});

		await page.request.post(`/api/projects/${project.slug}/tasks`, {
			headers,
			data: {
				project_id: project.id,
				title: 'Open task',
				assignee_id: assigneeId,
			},
		});

		const summaryDeadline = Date.now() + 15_000;
		while (Date.now() < summaryDeadline) {
			const summaryRes = await page.request.get(
				`/api/projects/${project.slug}/tasks/progress-summary`,
				{ headers },
			);
			const summary = ((await summaryRes.json()) as { data: { total: number } }).data;
			if (summary.total === 2) break;
			await new Promise((r) => setTimeout(r, 200));
		}

		await page.goto(`/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);

		const bar = page.getByTestId('task-progress-bar');
		await expect(bar).toBeVisible({ timeout: 20_000 });
		await expect(bar).toContainText('50% complete');
		await expect(bar).toContainText('1 of 2 tasks');
		await expect(page.getByTestId('project-status-idle')).toBeVisible();
		await expect(page.getByTestId('task-progress-segment-complete')).toBeVisible();
		// Assigning to an agent can wake the task into in_progress before first paint.
		await expect(
			page
				.getByTestId('task-progress-segment-in-progress')
				.or(page.getByTestId('task-progress-segment-not-done')),
		).toBeVisible({ timeout: 20_000 });
	});
});

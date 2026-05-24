import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, waitForPageLoad } from './helpers';

test.describe('Task blocked-by links', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('Blocked By row links to the blocking task', async ({ page, freshWorkspace }) => {
		const { team, token, agents } = freshWorkspace;
		const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
			name: 'Blocking Project',
			description: 'Seeded for blocked-by test.',
		});
		const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

		const blockerRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
			headers,
			data: { project_id: project.id, title: 'Upstream blocker', assignee_id: engineer.id },
		});
		const blocker = (
			(await blockerRes.json()) as {
				data: { id: string; identifier: string };
			}
		).data;

		const blockedRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
			headers,
			data: { project_id: project.id, title: 'Downstream blocked', assignee_id: engineer.id },
		});
		const blocked = (
			(await blockedRes.json()) as {
				data: { id: string; identifier: string };
			}
		).data;

		const depRes = await page.request.post(
			`/api/teams/${team.id}/tasks/${blocked.id}/dependencies`,
			{ headers, data: { blocked_by_task_id: blocker.id } },
		);
		expect(depRes.ok()).toBeTruthy();

		await page.goto(
			`/teams/${team.slug}/projects/${project.slug}/tasks/${blocked.identifier.toLowerCase()}`,
		);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Downstream blocked' })).toBeVisible({
			timeout: 20000,
		});

		const row = page.getByTestId('blocked-by-item');
		await expect(row).toBeVisible();
		await expect(row).toContainText(blocker.identifier);
		await expect(row).toContainText('Upstream blocker');

		await row.click();
		await expect(page.getByRole('heading', { name: 'Upstream blocker' })).toBeVisible({
			timeout: 20000,
		});
		expect(page.url()).toContain(
			`/teams/${team.slug}/projects/${project.slug}/tasks/${blocker.identifier.toLowerCase()}`,
		);
	});
});

import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

async function createProject(
	page: Page,
	teamId: string,
	token: string,
	name: string,
): Promise<{ id: string; slug: string }> {
	const res = await createProjectAndClearPlanning(page, teamId, token, {
		name,
		description: 'Assignee-status test project.',
	});
	return ((await res.json()) as { data: { id: string; slug: string } }).data;
}

async function createTask(
	page: Page,
	teamId: string,
	token: string,
	data: { project_id: string; title: string; assignee_id: string },
): Promise<{ id: string; identifier: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await page.request.post(`/api/teams/${teamId}/tasks`, { headers, data });
	return ((await res.json()) as { data: { id: string; identifier: string } }).data;
}

async function forceAgentsActive(page: Page, teamSlug: string) {
	await page.route(`**/api/teams/${teamSlug}/agents`, async (route) => {
		const response = await route.fetch();
		const body = (await response.json()) as { data: Array<{ runtime_status: string }> };
		for (const agent of body.data) agent.runtime_status = 'active';
		await route.fulfill({
			status: response.status(),
			contentType: 'application/json',
			body: JSON.stringify(body),
		});
	});
}

async function setHasActiveRun(page: Page, teamSlug: string, taskId: string, value: boolean) {
	await page.route(`**/api/teams/${teamSlug}/tasks/*`, async (route) => {
		const response = await route.fetch();
		const body = (await response.json()) as { data?: { id?: string; has_active_run?: boolean } };
		if (body.data && body.data.id === taskId) body.data.has_active_run = value;
		await route.fulfill({
			status: response.status(),
			contentType: 'application/json',
			body: JSON.stringify(body),
		});
	});
}

test.describe('Task detail — assignee status is ticket-scoped (mobile viewport)', () => {
	test('mobile layout: assignee badge follows the same idle rule', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		await page.setViewportSize({ width: 375, height: 720 });

		const { team, agents, token } = sharedWorkspace;
		const project = await createProject(page, team.id, token, uniqueName('Mobile Quiet'));
		const task = await createTask(page, team.id, token, {
			project_id: project.id,
			title: 'Mobile Ticket',
			assignee_id: agents[0].id,
		});

		await forceAgentsActive(page, team.slug);
		await setHasActiveRun(page, team.slug, task.id, false);

		await page.goto(
			`/teams/${team.slug}/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`,
		);
		await waitForPageLoad(page);

		const assignee = page.getByTestId('task-assignee');
		await expect(assignee).toBeVisible({ timeout: 20000 });
		await expect(assignee).toContainText('Idle');
		await expect(assignee).not.toContainText('Running');
	});
});

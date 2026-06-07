import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

async function createProject(
	page: Page,
	token: string,
	name: string,
): Promise<{ id: string; slug: string; assigneeId: string }> {
	const res = await createProjectAndClearPlanning(page, '', token, {
		name,
		description: 'Assignee-status test project.',
	});
	const project = ((await res.json()) as { data: { id: string; slug: string } }).data;
	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const assigneeId = (agents.find((a) => a.slug === 'captain') ?? agents[0]).id;
	return { ...project, assigneeId };
}

async function createTask(
	page: Page,
	projectSlug: string,
	token: string,
	data: { project_id: string; title: string; assignee_id: string },
): Promise<{ id: string; identifier: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await page.request.post(`/api/projects/${projectSlug}/tasks`, { headers, data });
	return ((await res.json()) as { data: { id: string; identifier: string } }).data;
}

async function forceAgentsActive(page: Page, projectSlug: string) {
	await page.route(`**/api/projects/${projectSlug}/agents`, async (route) => {
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

async function setHasActiveRun(page: Page, projectSlug: string, taskId: string, value: boolean) {
	await page.route(`**/api/projects/${projectSlug}/tasks/*`, async (route) => {
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

		const { token } = sharedWorkspace;
		const project = await createProject(page, token, uniqueName('Mobile Quiet'));
		const task = await createTask(page, project.slug, token, {
			project_id: project.id,
			title: 'Mobile Ticket',
			assignee_id: project.assigneeId,
		});

		await forceAgentsActive(page, project.slug);
		await setHasActiveRun(page, project.slug, task.id, false);

		await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
		await waitForPageLoad(page);

		const assignee = page.getByTestId('task-assignee');
		await expect(assignee).toBeVisible({ timeout: 20000 });
		await expect(assignee).toContainText('Idle');
		await expect(assignee).not.toContainText('Running');
	});
});

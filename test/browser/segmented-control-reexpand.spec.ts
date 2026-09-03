import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, waitForPageLoad } from './helpers';

// Real Chromium, because the whole thing is a measurement: the control reads what
// its labels need against the space its container offers, and happy-dom reports
// every width as zero (#1 in the test-tier decision tree - real layout).
//
// What this pins is that the collapse is reversible. The task sidebar is 190px on
// a desktop layout, where the English labels do not fit, and 248px once the layout
// stacks below 900px, where they do - so widening the container has to bring the
// words back rather than leaving the control latched to icons.

type CreatedProject = { id: string; slug: string; team_id: string };

async function createProjectAndTask(page: Page, token: string, name: string) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const projectRes = await createProjectAndClearPlanning(page, '', token, {
		name,
		description: 'Segmented control measurement test.',
	});
	const project = ((await projectRes.json()) as { data: CreatedProject }).data;

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Measurement Task',
			description: 'Segmented control measurement.',
			assignee_id: captain.id,
		},
	});
	const task = ((await taskRes.json()) as { data: { identifier: string } }).data;
	return { project, task };
}

test('the view control shows its labels again once there is room for them', async ({
	page,
	freshWorkspace,
}) => {
	const { project, task } = await createProjectAndTask(page, freshWorkspace.token, 'Seg Measure');

	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/projects/${project.slug}/tasks/${task.identifier}`);
	await waitForPageLoad(page);

	// The desktop sidebar is narrower than the words need, so the control is icons.
	const control = page.getByTestId('task-view-segmented');
	await expect(control).toBeVisible();
	await expect(control).toHaveAttribute('data-icons-only', 'true');

	// The stacked layout gives it a wider container, and the labels come back.
	await page.setViewportSize({ width: 900, height: 900 });
	await expect(control).not.toHaveAttribute('data-icons-only', 'true');

	// And they go again rather than sticking once the room is gone.
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(control).toHaveAttribute('data-icons-only', 'true');
});

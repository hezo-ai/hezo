import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, waitForPageLoad } from './helpers';

// Real Chromium, because the whole assertion is a measurement: the control reads
// what its labels need against what its container offers, and happy-dom reports
// every width as 0 (#1 in the test-tier decision tree - real layout).
//
// The control used to take the available width from *itself*. Hiding the labels
// shrank it, so the next measurement saw even less room and the collapse could
// never be undone - a sidebar widened back out kept its icons forever.

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

	const control = page.getByTestId('task-view-segmented');
	await expect(control).toBeVisible();
	await expect(control).not.toHaveAttribute('data-icons-only', 'true');

	// Narrow enough that the labels no longer fit beside one another.
	await page.setViewportSize({ width: 900, height: 900 });
	await expect(control).toHaveAttribute('data-icons-only', 'true');

	// And back: this is the half that never used to happen.
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(control).not.toHaveAttribute('data-icons-only', 'true');
});

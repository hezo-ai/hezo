// The Assignee column in the project task list is a narrow (120px), desktop-only
// (`hidden md:table-cell`) cell, and the task-detail side panel's Assignee field
// is similarly width-constrained. Long agent names like "Security Engineer" used
// to wrap onto a second line; both now render on a single line (truncated with an
// ellipsis if needed). This is a real-layout assertion — wrapping / cell height —
// that only a browser engine resolves (decision tree point 1), so it lives here
// rather than in the component tier.

import { expect, test } from './fixtures';
import {
	createProjectAndClearPlanning,
	expectSingleLine,
	uniqueName,
	waitForPageLoad,
} from './helpers';

test('long assignee names stay on one line in the task list and side panel', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { token } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const projectRes = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Assignee Truncation Project'),
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;

	// Pick the longest-named roster agent (e.g. "Security Engineer") so the cell
	// would wrap without the single-line treatment.
	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const projectAgents = (
		(await agentsRes.json()) as { data: Array<{ id: string; slug: string; title: string }> }
	).data;
	const agent = [...projectAgents].sort((a, b) => b.title.length - a.title.length)[0];

	const taskTitle = uniqueName('Wrap Check Task');
	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: taskTitle, assignee_id: agent.id },
	});
	const task = (await taskRes.json()).data;

	// --- Task list Assignee column (the reported screenshot) ---
	await page.goto(`/projects/${project.slug}/tasks`);
	await waitForPageLoad(page);

	// Scope to the task's own row so the team sidebar (which also lists the agent)
	// can't satisfy the locator. The row appears in whichever section the task is
	// in; the Assignee cell renders identically in both.
	const row = page.getByRole('row').filter({ hasText: taskTitle });
	await expect(row).toBeVisible({ timeout: 15_000 });
	const listAssignee = row.getByText(agent.title, { exact: true });
	await expect(listAssignee).toBeVisible();
	// Truncation is visual only — the full name stays in the DOM.
	await expect(listAssignee).toHaveText(agent.title);
	await expectSingleLine(listAssignee);

	// --- Task-detail side panel Assignee field ---
	await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
	await waitForPageLoad(page);

	const assigneeLink = page.getByTestId('task-assignee-link');
	await expect(assigneeLink).toBeVisible({ timeout: 15_000 });
	const sidebarAssignee = assigneeLink.getByText(agent.title, { exact: true });
	await expect(sidebarAssignee).toBeVisible();
	await expectSingleLine(sidebarAssignee);
});

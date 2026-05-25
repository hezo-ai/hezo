import { expect, test } from '@playwright/test';
import {
	authenticate,
	clickAndWaitForResponse,
	createProjectAndClearPlanning,
	createTeamWithAgents,
	waitForPageLoad,
} from './helpers';

test('status changes and cross-task mentions appear as system entries on the timeline', async ({
	page,
}) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'History Project',
		description: 'Project for history events.',
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const targetRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Target ticket', assignee_id: agent.id },
	});
	const target = ((await targetRes.json()) as { data: { id: string; identifier: string } }).data;

	const sourceRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Source ticket', assignee_id: agent.id },
	});
	const source = ((await sourceRes.json()) as { data: { id: string; identifier: string } }).data;

	const targetUrl = `/teams/${team.slug}/projects/${project.slug}/tasks/${target.identifier.toLowerCase()}`;
	await page.goto(targetUrl);
	await waitForPageLoad(page);

	const closeButton = page.getByTestId('task-close-button');
	await expect(closeButton).toBeVisible({ timeout: 20000 });
	await closeButton.click();
	// Scope the matcher to *this* task — the bare `/tasks/[^/]+` regex would
	// also satisfy any Captain planning-task PATCH that lands in the same
	// window, returning before the user's actual close has even left the
	// browser.
	const targetPath = `/api/teams/${team.slug}/tasks/${target.identifier.toLowerCase()}`;
	const closeResponse = await clickAndWaitForResponse(
		page,
		page.getByTestId('confirm-dialog-confirm'),
		(url, method) => method === 'PATCH' && url.pathname === targetPath,
	);
	expect(closeResponse.ok()).toBe(true);

	await expect(page.getByTestId('task-reopen-button')).toBeVisible({ timeout: 20000 });

	// Verify the status_change comment is actually in the DB before asserting on the
	// rendered chip — separates "server didn't record it" failures from "client
	// didn't render it" failures.
	const commentsPath = `/api/teams/${team.id}/tasks/${target.id}/comments`;
	await expect
		.poll(
			async () => {
				const res = await page.request.get(commentsPath, {
					headers: { Authorization: `Bearer ${token}` },
				});
				const body = (await res.json()) as {
					data: Array<{ content_type: string; content?: { kind?: string } }>;
				};
				return body.data.some(
					(c) => c.content_type === 'system' && c.content?.kind === 'status_change',
				);
			},
			{ timeout: 15000, message: 'status_change system comment never appeared in API' },
		)
		.toBe(true);

	// Hard reload after the API poll above has confirmed the entry exists
	// server-side: the page's React Query cache + Virtuoso scroll position can
	// race the post-mutation refetch under CI load, so just reload and let the
	// freshly-mounted page render the timeline from scratch.
	await page.reload();
	await waitForPageLoad(page);

	// Scroll the comments scroll container so Virtuoso mounts the bottom item.
	await page
		.locator('main')
		.first()
		.evaluate((el) => {
			el.scrollTo({ top: el.scrollHeight });
		});

	await expect(
		page.locator('[data-testid="comment-item"]').filter({ hasText: /changed status/i }),
	).toBeVisible({ timeout: 15000 });

	await page.request.post(`/api/teams/${team.id}/tasks/${source.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: `context: ${target.identifier}` } },
	});

	await page.goto(targetUrl);
	await waitForPageLoad(page);

	const linkEntry = page
		.locator('[data-testid="comment-item"]')
		.filter({ hasText: new RegExp(`Linked from ${source.identifier}`) });
	await expect(linkEntry).toBeVisible({ timeout: 15000 });

	await page.request.post(`/api/teams/${team.id}/tasks/${source.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: `still on ${target.identifier}` } },
	});

	await page.goto(targetUrl);
	await waitForPageLoad(page);

	const allLinkEntries = page
		.locator('[data-testid="comment-item"]')
		.filter({ hasText: new RegExp(`Linked from ${source.identifier}`) });
	await expect(allLinkEntries).toHaveCount(1);
});

test('title renames appear as system entries on the timeline', async ({ page }) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Rename Project',
		description: 'Project for rename events.',
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Original ticket', assignee_id: agent.id },
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.request.patch(`/api/teams/${team.id}/tasks/${task.id}`, {
		headers,
		data: { title: 'Renamed ticket' },
	});

	const taskUrl = `/teams/${team.slug}/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`;
	await page.goto(taskUrl);
	await waitForPageLoad(page);

	await expect(
		page.locator('[data-testid="comment-item"]').filter({ hasText: /renamed from/i }),
	).toBeVisible({ timeout: 15000 });
});

test('reassignments appear as system entries on the timeline', async ({ page }) => {
	await authenticate(page);
	const { team, token } = await createTeamWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data;
	expect(agents.length).toBeGreaterThanOrEqual(2);
	const [first, second] = agents;

	const projectRes = await createProjectAndClearPlanning(page, team.id, token, {
		name: 'Reassign Project',
		description: 'Project for reassignment events.',
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const taskRes = await page.request.post(`/api/teams/${team.id}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Reassign me', assignee_id: first.id },
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.request.patch(`/api/teams/${team.id}/tasks/${task.id}`, {
		headers,
		data: { assignee_id: second.id },
	});

	const taskUrl = `/teams/${team.slug}/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`;
	await page.goto(taskUrl);
	await waitForPageLoad(page);

	await expect(
		page.locator('[data-testid="comment-item"]').filter({ hasText: /reassigned from/i }),
	).toBeVisible({ timeout: 15000 });
});

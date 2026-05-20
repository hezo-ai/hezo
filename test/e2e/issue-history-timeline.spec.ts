import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test('status changes and cross-issue mentions appear as system entries on the timeline', async ({
	page,
}) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'History Project', description: 'Project for history events.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const targetRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Target ticket', assignee_id: agent.id },
	});
	const target = ((await targetRes.json()) as { data: { id: string; identifier: string } }).data;

	const sourceRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Source ticket', assignee_id: agent.id },
	});
	const source = ((await sourceRes.json()) as { data: { id: string; identifier: string } }).data;

	const targetUrl = `/companies/${company.slug}/projects/${project.slug}/issues/${target.identifier.toLowerCase()}`;
	await page.goto(targetUrl);
	await waitForPageLoad(page);

	const closeButton = page.getByTestId('issue-close-button');
	await expect(closeButton).toBeVisible({ timeout: 20000 });
	await closeButton.click();
	await page.getByTestId('confirm-dialog-confirm').click();

	await expect(page.getByTestId('issue-reopen-button')).toBeVisible({ timeout: 20000 });

	await expect(
		page.locator('[data-testid="comment-item"]').filter({ hasText: /changed status/i }),
	).toBeVisible({ timeout: 15000 });

	await page.request.post(`/api/companies/${company.id}/issues/${source.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: `context: ${target.identifier}` } },
	});

	await page.goto(targetUrl);
	await waitForPageLoad(page);

	const linkEntry = page
		.locator('[data-testid="comment-item"]')
		.filter({ hasText: new RegExp(`Linked from ${source.identifier}`) });
	await expect(linkEntry).toBeVisible({ timeout: 15000 });

	await page.request.post(`/api/companies/${company.id}/issues/${source.id}/comments`, {
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
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Rename Project', description: 'Project for rename events.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Original ticket', assignee_id: agent.id },
	});
	const issue = ((await issueRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.request.patch(`/api/companies/${company.id}/issues/${issue.id}`, {
		headers,
		data: { title: 'Renamed ticket' },
	});

	const issueUrl = `/companies/${company.slug}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`;
	await page.goto(issueUrl);
	await waitForPageLoad(page);

	await expect(
		page.locator('[data-testid="comment-item"]').filter({ hasText: /renamed from/i }),
	).toBeVisible({ timeout: 15000 });
});

test('reassignments appear as system entries on the timeline', async ({ page }) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string }> }).data;
	expect(agents.length).toBeGreaterThanOrEqual(2);
	const [first, second] = agents;

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Reassign Project', description: 'Project for reassignment events.' },
	});
	const project = ((await projectRes.json()) as { data: { id: string; slug: string } }).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Reassign me', assignee_id: first.id },
	});
	const issue = ((await issueRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.request.patch(`/api/companies/${company.id}/issues/${issue.id}`, {
		headers,
		data: { assignee_id: second.id },
	});

	const issueUrl = `/companies/${company.slug}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`;
	await page.goto(issueUrl);
	await waitForPageLoad(page);

	await expect(
		page.locator('[data-testid="comment-item"]').filter({ hasText: /reassigned from/i }),
	).toBeVisible({ timeout: 15000 });
});

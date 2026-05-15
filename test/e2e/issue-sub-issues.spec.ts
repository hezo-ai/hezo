import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test('sub-issues panel is expanded by default and collapses on click', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; slug: string }[];
	const ceo = agents.find((a) => a.slug === 'ceo')!;
	const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Sub-Issues Project', description: 'Seeded for sub-issues test.' },
	});
	const project = (await projectRes.json()).data;

	const parentRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Parent Issue', assignee_id: engineer.id },
	});
	const parent = (await parentRes.json()).data;

	const childAPayload = {
		title: 'Child Issue Alpha',
		assignee_id: engineer.id,
	};
	const childBPayload = {
		title: 'Child Issue Beta',
		assignee_id: engineer.id,
	};
	const childARes = await page.request.post(
		`/api/companies/${company.id}/issues/${parent.id}/sub-issues`,
		{ headers, data: childAPayload },
	);
	expect(childARes.ok()).toBeTruthy();
	const childBRes = await page.request.post(
		`/api/companies/${company.id}/issues/${parent.id}/sub-issues`,
		{ headers, data: childBPayload },
	);
	expect(childBRes.ok()).toBeTruthy();

	await page.goto(`/companies/${company.id}/issues/${parent.id}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Parent Issue' })).toBeVisible({ timeout: 20000 });

	const toggle = page.getByTestId('sub-issues-toggle');
	await expect(toggle).toBeVisible();
	await expect(toggle).toContainText('Sub-issues');
	await expect(toggle).toContainText('2');
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	const list = page.getByTestId('sub-issues-list');
	await expect(list).toBeVisible();
	await expect(list.getByText('Child Issue Alpha')).toBeVisible();
	await expect(list.getByText('Child Issue Beta')).toBeVisible();

	// With only 2 sub-issues and a default page size of 10, no "Show more" should appear.
	await expect(page.getByTestId('sub-issues-show-more')).toHaveCount(0);

	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(list).toBeHidden();

	// CEO agent variable retained to validate presence in the seeded company.
	expect(ceo).toBeDefined();
});

test('sub-issues paginate to company page size with a Show more link', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	// Set the page size to 3 for this company so we don't have to seed dozens of sub-issues.
	const patchRes = await page.request.patch(`/api/companies/${company.id}`, {
		headers,
		data: { settings: { subtask_page_size: 3 } },
	});
	expect(patchRes.ok()).toBeTruthy();

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; slug: string }[];
	const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Pagination Project', description: 'Seeded for pagination test.' },
	});
	const project = (await projectRes.json()).data;

	const parentRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Pagination Parent', assignee_id: engineer.id },
	});
	const parent = (await parentRes.json()).data;

	const titles = ['Sub A', 'Sub B', 'Sub C', 'Sub D', 'Sub E', 'Sub F', 'Sub G'];
	for (const title of titles) {
		const res = await page.request.post(
			`/api/companies/${company.id}/issues/${parent.id}/sub-issues`,
			{ headers, data: { title, assignee_id: engineer.id } },
		);
		expect(res.ok()).toBeTruthy();
	}

	await page.goto(`/companies/${company.id}/issues/${parent.id}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Pagination Parent' })).toBeVisible({
		timeout: 20000,
	});

	const list = page.getByTestId('sub-issues-list');
	await expect(list).toBeVisible();

	// First batch — 3 visible, 4 hidden.
	await expect(list.getByTestId('sub-issue-item')).toHaveCount(3);
	const showMore = page.getByTestId('sub-issues-show-more');
	await expect(showMore).toBeVisible();
	await expect(showMore).toContainText('4 hidden');

	// Second batch — 6 visible, 1 hidden.
	await showMore.click();
	await expect(list.getByTestId('sub-issue-item')).toHaveCount(6);
	await expect(showMore).toContainText('1 hidden');

	// Final batch — all 7 visible, link gone.
	await showMore.click();
	await expect(list.getByTestId('sub-issue-item')).toHaveCount(7);
	await expect(page.getByTestId('sub-issues-show-more')).toHaveCount(0);
});

test('sub-issues panel sits between description card and comments', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; slug: string }[];
	const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Layout Project', description: 'Seeded for layout check.' },
	});
	const project = (await projectRes.json()).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Layout Parent',
			description: 'Some description body.',
			assignee_id: engineer.id,
		},
	});
	const issue = (await issueRes.json()).data;

	await page.goto(`/companies/${company.id}/issues/${issue.id}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Layout Parent' })).toBeVisible({
		timeout: 20000,
	});

	const descriptionCard = page.getByTestId('issue-description-card');
	await expect(descriptionCard).toBeVisible();
	await expect(descriptionCard).toContainText('Description');
	await expect(descriptionCard.getByTestId('issue-description')).toBeVisible();

	const subIssuesCard = page.getByTestId('sub-issues-card');
	await expect(subIssuesCard).toBeVisible();

	const descBox = await descriptionCard.boundingBox();
	const subBox = await subIssuesCard.boundingBox();
	const commentsHeading = page.getByRole('heading', { name: 'Comments' });
	const commentsBox = await commentsHeading.boundingBox();

	expect(descBox).not.toBeNull();
	expect(subBox).not.toBeNull();
	expect(commentsBox).not.toBeNull();
	expect(subBox!.y).toBeGreaterThan(descBox!.y);
	expect(commentsBox!.y).toBeGreaterThan(subBox!.y);
});

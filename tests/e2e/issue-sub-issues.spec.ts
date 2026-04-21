import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test('sub-issues panel is collapsed by default and expands on click', async ({ page }) => {
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
	await expect(page.getByRole('heading', { name: 'Parent Issue' })).toBeVisible({ timeout: 10000 });

	const toggle = page.getByTestId('sub-issues-toggle');
	await expect(toggle).toBeVisible();
	await expect(toggle).toContainText('Sub-issues');
	await expect(toggle).toContainText('2');
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByTestId('sub-issues-list')).toBeHidden();

	await toggle.click();

	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	const list = page.getByTestId('sub-issues-list');
	await expect(list).toBeVisible();
	await expect(list.getByText('Child Issue Alpha')).toBeVisible();
	await expect(list.getByText('Child Issue Beta')).toBeVisible();

	// CEO agent variable retained to validate presence in the seeded company.
	expect(ceo).toBeDefined();
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
		timeout: 10000,
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

import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test('breadcrumb walks the parent chain on a sub-sub-issue', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; slug: string }[];
	const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Breadcrumb Project', description: 'Seeded for breadcrumb test.' },
	});
	const project = (await projectRes.json()).data;

	const rootRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Root Issue', assignee_id: engineer.id },
	});
	const root = (await rootRes.json()).data;

	const subRes = await page.request.post(
		`/api/companies/${company.id}/issues/${root.id}/sub-issues`,
		{ headers, data: { title: 'Sub Issue', assignee_id: engineer.id } },
	);
	const sub = (await subRes.json()).data;

	const subSubRes = await page.request.post(
		`/api/companies/${company.id}/issues/${sub.id}/sub-issues`,
		{ headers, data: { title: 'Sub-Sub Issue', assignee_id: engineer.id } },
	);
	const subSub = (await subSubRes.json()).data;

	await page.goto(
		`/companies/${company.id}/projects/${project.slug}/issues/${subSub.identifier.toLowerCase()}`,
	);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Sub-Sub Issue' })).toBeVisible({
		timeout: 20000,
	});

	const breadcrumb = page.getByTestId('breadcrumb');
	await expect(breadcrumb).toContainText(root.identifier);
	await expect(breadcrumb).toContainText(sub.identifier);
	await expect(breadcrumb).toContainText(subSub.identifier);

	const rootLink = breadcrumb.getByRole('link', { name: root.identifier });
	const subLink = breadcrumb.getByRole('link', { name: sub.identifier });
	await expect(rootLink).toBeVisible();
	await expect(subLink).toBeVisible();

	await rootLink.click();
	await expect(page.getByRole('heading', { name: 'Root Issue' })).toBeVisible({ timeout: 20000 });
});

test('breadcrumb on a top-level issue shows no ancestors', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; slug: string }[];
	const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Top Project', description: 'Top-level breadcrumb check.' },
	});
	const project = (await projectRes.json()).data;

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: { project_id: project.id, title: 'Top-Level Issue', assignee_id: engineer.id },
	});
	const issue = (await issueRes.json()).data;

	await page.goto(
		`/companies/${company.id}/projects/${project.slug}/issues/${issue.identifier.toLowerCase()}`,
	);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Top-Level Issue' })).toBeVisible({
		timeout: 20000,
	});

	const breadcrumb = page.getByTestId('breadcrumb');
	await expect(breadcrumb).toContainText('Issues');
	await expect(breadcrumb).toContainText(issue.identifier);
	await expect(breadcrumb.getByRole('link')).toHaveCount(3); // Projects, project name, Issues
});

test('UI surfaces the depth-cap error when creating a sub-issue under a depth-2 ticket', async ({
	page,
}) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = (await agentsRes.json()).data as { id: string; slug: string }[];
	const engineer = agents.find((a) => a.slug === 'engineer') ?? agents[0];

	const projectRes = await page.request.post(`/api/companies/${company.id}/projects`, {
		headers,
		data: { name: 'Depth Project', description: 'Depth-cap UI check.' },
	});
	const project = (await projectRes.json()).data;

	const root = (
		await (
			await page.request.post(`/api/companies/${company.id}/issues`, {
				headers,
				data: { project_id: project.id, title: 'Depth Root', assignee_id: engineer.id },
			})
		).json()
	).data;
	const sub = (
		await (
			await page.request.post(`/api/companies/${company.id}/issues/${root.id}/sub-issues`, {
				headers,
				data: { title: 'Depth Sub', assignee_id: engineer.id },
			})
		).json()
	).data;
	const subSub = (
		await (
			await page.request.post(`/api/companies/${company.id}/issues/${sub.id}/sub-issues`, {
				headers,
				data: { title: 'Depth Sub-Sub', assignee_id: engineer.id },
			})
		).json()
	).data;

	await page.goto(
		`/companies/${company.id}/projects/${project.slug}/issues/${subSub.identifier.toLowerCase()}`,
	);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Depth Sub-Sub' })).toBeVisible({
		timeout: 20000,
	});

	await page.getByTestId('sub-issues-add').click();
	await page.getByTestId('sub-issue-title-input').fill('Should be rejected');
	await page.getByRole('button', { name: 'Create' }).click();

	await expect(page.getByTestId('sub-issue-error')).toContainText(/2 levels deep/);
});

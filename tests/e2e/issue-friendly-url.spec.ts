import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, createProjectAndClearPlanning } from './helpers';

test('canonical issue URL is project-scoped; short and UUID forms redirect', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'URL Test Project',
		description: 'Validates friendly issue URLs.',
	});

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo');
	if (!ceo) throw new Error('CEO agent not found');

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers: { ...headers, 'Content-Type': 'application/json' },
		data: {
			project_id: project.id,
			title: 'Friendly URL issue',
			assignee_id: ceo.id,
		},
	});
	const issue = (
		(await issueRes.json()) as {
			data: { id: string; identifier: string; title: string };
		}
	).data;
	const friendly = issue.identifier.toLowerCase();
	const canonicalPath = `/companies/${company.slug}/projects/${project.slug}/issues/${friendly}`;

	await page.goto(canonicalPath);
	await expect(page.getByRole('heading', { name: issue.title })).toBeVisible();
	expect(new URL(page.url()).pathname).toBe(canonicalPath);

	await page.goto(`/companies/${company.slug}/issues/${friendly}`);
	await page.waitForURL(`**${canonicalPath}`, { timeout: 20000 });
	expect(new URL(page.url()).pathname).toBe(canonicalPath);
	await expect(page.getByRole('heading', { name: issue.title })).toBeVisible();

	await page.goto(`/companies/${company.slug}/issues/${issue.id}`);
	await page.waitForURL(`**${canonicalPath}`, { timeout: 20000 });
	expect(new URL(page.url()).pathname).toBe(canonicalPath);
	await expect(page.getByRole('heading', { name: issue.title })).toBeVisible();

	await page.goto(`/companies/${company.slug}/projects/${project.slug}/issues/${issue.id}`);
	await page.waitForURL(`**${canonicalPath}`, { timeout: 20000 });
	expect(new URL(page.url()).pathname).toBe(canonicalPath);
	await expect(page.getByRole('heading', { name: issue.title })).toBeVisible();
});

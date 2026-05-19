import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, waitForPageLoad } from './helpers';

test.describe('Repo Setup Approval', () => {
	async function seedBlockedProject(page: import('@playwright/test').Page) {
		const { company, token } = await createCompanyWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projRes = await page.request.post(`/api/companies/${company.id}/projects`, {
			headers,
			data: { name: 'Blocked Project', description: 'Project waiting on repo' },
		});
		const project = ((await projRes.json()) as { data: { id: string; slug: string } }).data;

		const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const agents = ((await agentsRes.json()) as { data: Array<{ id: string; title: string }> })
			.data;
		const agentA = agents[0];
		const agentB = agents[1] ?? agentA;

		const issuesData = await Promise.all(
			[
				{ title: 'Migrate to vNext', assignee_id: agentA.id },
				{ title: 'Add CI workflow', assignee_id: agentB.id },
			].map(async (i) => {
				const r = await page.request.post(`/api/companies/${company.id}/issues`, {
					headers,
					data: { project_id: project.id, ...i },
				});
				return ((await r.json()) as { data: { id: string; identifier: string } }).data;
			}),
		);

		const approvalRes = await page.request.post(`/api/companies/${company.id}/approvals`, {
			headers,
			data: {
				type: 'designated_repo_request',
				payload: {
					platform: 'github',
					reason: 'designated_repo',
					project_id: project.id,
					issue_id: issuesData[0].id,
				},
			},
		});
		const approval = ((await approvalRes.json()) as { data: { id: string } }).data;

		for (const issue of issuesData) {
			await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/comments`, {
				headers,
				data: {
					content_type: 'action',
					content: { kind: 'setup_repo', approval_id: approval.id },
				},
			});
		}

		return { company, project, approval, issues: issuesData, agents: [agentA, agentB], token };
	}

	test('inbox card opens popup listing every blocked ticket', async ({ page }) => {
		await authenticate(page);
		const { company, issues } = await seedBlockedProject(page);

		await page.goto(`/companies/${company.slug}/inbox`);
		await waitForPageLoad(page);

		const card = page.getByTestId('approval-card').filter({ hasText: 'Requesting GitHub OAuth' });
		await expect(card).toBeVisible({ timeout: 15000 });
		await expect(card).toHaveCount(1);

		await card.click();

		const modal = page.getByTestId('repo-setup-approval-modal');
		await expect(modal).toBeVisible({ timeout: 10000 });
		for (const issue of issues) {
			await expect(modal.getByTestId(`blocked-ticket-${issue.identifier}`)).toBeVisible();
		}
	});

	test('clicking a ticket row navigates to the comment with a brief highlight', async ({
		page,
	}) => {
		await authenticate(page);
		const { company, project, issues } = await seedBlockedProject(page);

		await page.goto(`/companies/${company.slug}/inbox`);
		await waitForPageLoad(page);

		await page.getByTestId('approval-card').first().click();

		const firstTicket = page.getByTestId(`blocked-ticket-${issues[0].identifier}`);
		await expect(firstTicket).toBeVisible({ timeout: 10000 });
		await firstTicket.click();

		await expect(page).toHaveURL(
			new RegExp(
				`/companies/${company.slug}/projects/${project.slug}/issues/${issues[0].identifier.toLowerCase()}`,
			),
			{ timeout: 15000 },
		);

		const highlighted = page.locator('[data-comment-highlighted="true"]');
		await expect(highlighted).toBeVisible({ timeout: 10000 });
	});

	test('CTA navigates to the project settings page', async ({ page }) => {
		await authenticate(page);
		const { company, project } = await seedBlockedProject(page);

		await page.goto(`/companies/${company.slug}/inbox`);
		await waitForPageLoad(page);

		await page.getByTestId('approval-card').first().click();
		await page.getByTestId('repo-setup-approval-cta').click();

		await expect(page).toHaveURL(
			new RegExp(`/companies/${company.slug}/projects/${project.slug}/settings`),
			{ timeout: 15000 },
		);
		await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible({
			timeout: 15000,
		});
	});
});

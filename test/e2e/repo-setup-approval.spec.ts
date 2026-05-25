import { expect, test } from '@playwright/test';
import {
	authenticate,
	createProjectAndClearPlanning,
	createTeamWithAgents,
	waitForPageLoad,
} from './helpers';

test.describe('Repo Setup Approval', () => {
	async function seedBlockedProject(page: import('@playwright/test').Page) {
		const { team, token } = await createTeamWithAgents(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projRes = await createProjectAndClearPlanning(page, team.id, token, {
			name: 'Blocked Project',
			description: 'Project waiting on repo',
		});
		const project = ((await projRes.json()) as { data: { id: string; slug: string } }).data;

		const agentsRes = await page.request.get(`/api/teams/${team.id}/agents`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const agents = ((await agentsRes.json()) as { data: Array<{ id: string; title: string }> })
			.data;
		const agentA = agents[0];
		const agentB = agents[1] ?? agentA;

		const tasksData = await Promise.all(
			[
				{ title: 'Migrate to vNext', assignee_id: agentA.id },
				{ title: 'Add CI workflow', assignee_id: agentB.id },
			].map(async (i) => {
				const r = await page.request.post(`/api/teams/${team.id}/tasks`, {
					headers,
					data: { project_id: project.id, ...i },
				});
				return ((await r.json()) as { data: { id: string; identifier: string } }).data;
			}),
		);

		const approvalRes = await page.request.post(`/api/teams/${team.id}/approvals`, {
			headers,
			data: {
				type: 'designated_repo_request',
				payload: {
					platform: 'github',
					reason: 'designated_repo',
					project_id: project.id,
					task_id: tasksData[0].id,
				},
			},
		});
		const approval = ((await approvalRes.json()) as { data: { id: string } }).data;

		for (const task of tasksData) {
			await page.request.post(`/api/teams/${team.id}/tasks/${task.id}/comments`, {
				headers,
				data: {
					content_type: 'action',
					content: { kind: 'setup_repo', approval_id: approval.id },
				},
			});
		}

		return { team, project, approval, tasks: tasksData, agents: [agentA, agentB], token };
	}

	test('inbox card opens popup listing every blocked ticket', async ({ page }) => {
		await authenticate(page);
		const { team, tasks } = await seedBlockedProject(page);

		await page.goto(`/teams/${team.slug}/inbox`);
		await waitForPageLoad(page);

		const card = page.getByTestId('approval-card').filter({ hasText: 'Requesting GitHub OAuth' });
		await expect(card).toBeVisible({ timeout: 15000 });
		await expect(card).toHaveCount(1);

		await card.click();

		const modal = page.getByTestId('repo-setup-approval-modal');
		await expect(modal).toBeVisible({ timeout: 10000 });
		for (const task of tasks) {
			await expect(modal.getByTestId(`blocked-ticket-${task.identifier}`)).toBeVisible();
		}
	});

	test('clicking a ticket row navigates to the comment with a brief highlight', async ({
		page,
	}) => {
		await authenticate(page);
		const { team, project, tasks } = await seedBlockedProject(page);

		await page.goto(`/teams/${team.slug}/inbox`);
		await waitForPageLoad(page);

		await page.getByTestId('approval-card').first().click();

		const firstTicket = page.getByTestId(`blocked-ticket-${tasks[0].identifier}`);
		await expect(firstTicket).toBeVisible({ timeout: 10000 });
		await firstTicket.click();

		await expect(page).toHaveURL(
			new RegExp(
				`/teams/${team.slug}/projects/${project.slug}/tasks/${tasks[0].identifier.toLowerCase()}`,
			),
			{ timeout: 15000 },
		);

		const highlighted = page.locator('[data-comment-highlighted="true"]');
		await expect(highlighted).toBeVisible({ timeout: 10000 });
	});

	test('CTA navigates to the project settings page', async ({ page }) => {
		await authenticate(page);
		const { team, project } = await seedBlockedProject(page);

		await page.goto(`/teams/${team.slug}/inbox`);
		await waitForPageLoad(page);

		await page.getByTestId('approval-card').first().click();
		await page.getByTestId('repo-setup-approval-cta').click();

		await expect(page).toHaveURL(
			new RegExp(`/teams/${team.slug}/projects/${project.slug}/settings`),
			{ timeout: 15000 },
		);
		await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible({
			timeout: 15000,
		});
	});
});

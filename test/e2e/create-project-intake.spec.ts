import { expect, test } from '@playwright/test';
import { authenticate, createTeamWithAgents, waitForPageLoad } from './helpers';

test.describe('Create Project intake', () => {
	test('Create Project form opens an intake ticket and approval, then approving creates the project', async ({
		page,
	}) => {
		await authenticate(page);
		const { team, token } = await createTeamWithAgents(page);
		const headers = { Authorization: `Bearer ${token}` };

		await page.goto(`/teams/${team.slug}/projects`);
		await waitForPageLoad(page);

		await page.getByRole('main').getByRole('button', { name: 'New project' }).click();
		await page.getByLabel('Name').fill('Customer Portal');
		await page
			.getByLabel('Description')
			.fill('Self-serve portal for customers to manage subscriptions.');

		const submitPromise = page.waitForResponse(
			(r) => r.url().endsWith(`/api/teams/${team.id}/projects`) && r.request().method() === 'POST',
		);
		await page.getByRole('button', { name: 'Create' }).click();
		const submitRes = await submitPromise;
		expect(submitRes.status()).toBe(201);
		const intake = (
			(await submitRes.json()) as {
				data: { intake_task_identifier: string; approval_id: string };
			}
		).data;

		await expect(page).toHaveURL(
			new RegExp(`/teams/${team.slug}/projects/internal/tasks/[a-z0-9-]+(?:#.*)?$`),
			{ timeout: 15000 },
		);
		await expect(page.getByRole('main').getByText('Open new project: Customer Portal')).toBeVisible(
			{
				timeout: 15000,
			},
		);
		await expect(page.getByText("I'm the Captain")).toBeVisible({ timeout: 15000 });

		// No user-facing project should exist yet.
		const beforeRes = await page.request.get(`/api/teams/${team.id}/projects`, { headers });
		const beforeProjects = (
			(await beforeRes.json()) as {
				data: Array<{ slug: string; is_internal: boolean }>;
			}
		).data;
		expect(beforeProjects.some((p) => p.slug === 'customer-portal')).toBe(false);

		// Wait for the UI's POST to land, then resolve the approval. Sequencing
		// the page.request.post after the UI mutation per the AGENTS.md timing rules.
		await page.request.post(`/api/approvals/${intake.approval_id}/resolve`, {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: { status: 'approved' },
		});

		// Verify the project + planning task now exist.
		const afterRes = await page.request.get(`/api/teams/${team.id}/projects`, { headers });
		const afterProjects = (
			(await afterRes.json()) as {
				data: Array<{ id: string; slug: string; name: string }>;
			}
		).data;
		const customerPortal = afterProjects.find((p) => p.slug === 'customer-portal');
		expect(customerPortal).toBeDefined();
		expect(customerPortal?.name).toBe('Customer Portal');

		const tasksRes = await page.request.get(
			`/api/teams/${team.id}/tasks?project_id=${customerPortal!.id}`,
			{ headers },
		);
		const tasks = ((await tasksRes.json()) as { data: Array<{ title: string; labels: string[] }> })
			.data;
		expect(tasks.some((t) => (t.labels ?? []).includes('planning'))).toBe(true);
	});
});

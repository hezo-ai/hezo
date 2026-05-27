import { expect, test } from './fixtures';
import { uniqueName, waitForPageLoad } from './helpers';

test.describe('Create Project intake', () => {
	test('Create Project form opens an intake ticket and approval, then approving creates the project', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { team, token } = sharedWorkspace;
		const headers = { Authorization: `Bearer ${token}` };
		const projectName = uniqueName('Customer Portal');
		const projectSlug = projectName.toLowerCase().replace(/\s+/g, '-');

		await page.goto(`/teams/${team.slug}/projects`);
		await waitForPageLoad(page);

		await page.getByRole('main').getByRole('button', { name: 'New project' }).click();
		await page.getByLabel('Name').fill(projectName);
		await page
			.getByLabel('Description')
			.fill('Self-serve portal for customers to manage subscriptions.');

		const submitPromise = page.waitForResponse(
			(r) =>
				r.url().endsWith(`/api/teams/${team.slug}/projects`) && r.request().method() === 'POST',
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
		await expect(page.getByRole('main').getByText(`Open new project: ${projectName}`)).toBeVisible({
			timeout: 15000,
		});
		await expect(page.getByText("I'm the Captain")).toBeVisible({ timeout: 15000 });

		const beforeRes = await page.request.get(`/api/teams/${team.id}/projects`, { headers });
		const beforeProjects = (
			(await beforeRes.json()) as {
				data: Array<{ slug: string; is_internal: boolean }>;
			}
		).data;
		expect(beforeProjects.some((p) => p.slug === projectSlug)).toBe(false);

		await page.request.post(`/api/approvals/${intake.approval_id}/resolve`, {
			headers: { ...headers, 'Content-Type': 'application/json' },
			data: { status: 'approved' },
		});

		const afterRes = await page.request.get(`/api/teams/${team.id}/projects`, { headers });
		const afterProjects = (
			(await afterRes.json()) as {
				data: Array<{ id: string; slug: string; name: string }>;
			}
		).data;
		const created = afterProjects.find((p) => p.slug === projectSlug);
		expect(created).toBeDefined();
		expect(created?.name).toBe(projectName);

		const tasksRes = await page.request.get(
			`/api/teams/${team.id}/tasks?project_id=${created!.id}`,
			{ headers },
		);
		const tasks = ((await tasksRes.json()) as { data: Array<{ title: string; labels: string[] }> })
			.data;
		expect(tasks.some((t) => (t.labels ?? []).includes('planning'))).toBe(true);
	});
});

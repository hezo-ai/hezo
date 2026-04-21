import { expect, type Page, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents, createProjectAndClearPlanning } from './helpers';

async function waitForContainer(page: Page, companyId: string, projectId: string, token: string) {
	const headers = { Authorization: `Bearer ${token}` };
	for (let i = 0; i < 30; i++) {
		const res = await page.request.get(`/api/companies/${companyId}/projects/${projectId}`, {
			headers,
		});
		const body = (await res.json()) as { data: { container_status?: string } };
		if (body.data?.container_status === 'running') return;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error('Container did not reach running state within 15s');
}

async function waitForRunStatus(
	page: Page,
	companyId: string,
	issueId: string,
	token: string,
	timeoutMs = 30_000,
) {
	const headers = { Authorization: `Bearer ${token}` };
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await page.request.get(`/api/companies/${companyId}/issues/${issueId}/latest-run`, {
			headers,
		});
		const body = (await res.json()) as { data: null | { id: string; status: string } };
		if (body.data && body.data.status === 'succeeded') return body.data;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`Latest run did not succeed within ${timeoutMs}ms`);
}

test('log viewer expands to full viewport and collapses via button and Escape', async ({
	page,
}) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo') ?? agents[0];

	const project = await createProjectAndClearPlanning(page, company.id, token, {
		name: 'Fullscreen Log Project',
		description: 'Test project.',
	});

	await waitForContainer(page, company.id, project.id, token);

	const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Expand Log Viewer',
			description: 'Synthetic test task',
			assignee_id: ceo.id,
		},
	});
	const issue = ((await issueRes.json()) as { data: { id: string } }).data;

	await page.request.post(`/api/companies/${company.id}/issues/${issue.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: 'Please begin' } },
	});

	const run = await waitForRunStatus(page, company.id, issue.id, token);

	await page.goto(`/companies/${company.slug}/agents/${ceo.id}/executions/${run.id}`);

	const inlineLog = page.getByTestId('run-log');
	await expect(inlineLog).toBeVisible({ timeout: 10_000 });
	await expect(inlineLog).toContainText('[synthetic]', { timeout: 10_000 });

	const expandBtn = page.getByRole('button', { name: /expand log viewer/i });
	await expect(expandBtn).toBeVisible();
	await expandBtn.click();

	const fullscreen = page.getByTestId('log-viewer-fullscreen');
	await expect(fullscreen).toBeVisible();

	const viewport = page.viewportSize();
	if (viewport) {
		const box = await fullscreen.boundingBox();
		expect(box).not.toBeNull();
		if (box) {
			expect(box.width).toBe(viewport.width);
			expect(box.height).toBe(viewport.height);
		}
	}

	await page.keyboard.press('Escape');
	await expect(fullscreen).toBeHidden();
	await expect(inlineLog).toBeVisible();

	await expandBtn.click();
	await expect(fullscreen).toBeVisible();

	const collapseBtn = page.getByRole('button', { name: /collapse log viewer/i });
	await collapseBtn.click();
	await expect(fullscreen).toBeHidden();
	await expect(inlineLog).toBeVisible();
});

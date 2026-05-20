import { expect, test } from './fixtures';
import { dismissAiProviderModal, waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

async function setAgentSummary(
	page: Page,
	token: string,
	companyId: string,
	agentId: string,
	summary: string,
) {
	const res = await page.request.post('/mcp', {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'set_agent_summary',
				arguments: { company_id: companyId, agent_id: agentId, summary },
			},
		},
	});
	const body = await res.json();
	const payload = JSON.parse(body.result.content[0].text);
	expect(payload.updated).toBe(true);
}

test('team org chart renders with status legend', async ({ page, freshWorkspace }) => {
	const { company } = freshWorkspace;
	await page.goto(`/companies/${company.slug}/agents`);

	await expect(page.getByText('You (Board)')).toBeVisible({ timeout: 20000 });
	await expect(page.getByText('Active').first()).toBeVisible({ timeout: 15000 });
});

test('agent detail page defaults to Executions tab and exposes Settings tab', async ({
	page,
	freshWorkspace,
}) => {
	const { company, agents } = freshWorkspace;
	const agent = agents[0];

	await page.goto(`/companies/${company.slug}/agents/${agent.id}`);

	const executionsLink = page.getByRole('link', { name: 'Executions' });
	await expect(executionsLink).toBeVisible({ timeout: 15000 });
	await expect(executionsLink).toHaveClass(/border-primary/, { timeout: 15000 });
	await expect(page.getByRole('main').getByRole('link', { name: 'Settings' })).toBeVisible({
		timeout: 15000,
	});
});

test('agent settings tab shows budget, heartbeat, title, and save controls', async ({
	page,
	freshWorkspace,
}) => {
	const { company, agents } = freshWorkspace;
	const agent = agents[0];

	await page.goto(`/companies/${company.slug}/agents/${agent.id}/settings`);

	await expect(page.getByText('Budget Usage')).toBeVisible({ timeout: 15000 });
	await expect(page.getByText('Heartbeat').first()).toBeVisible({ timeout: 15000 });
	await expect(page.getByLabel('Title')).toBeVisible({ timeout: 15000 });
	await expect(page.getByRole('button', { name: 'Save Changes' })).toBeVisible({ timeout: 15000 });
});

test('agent settings tab edits the title and persists across reload', async ({
	page,
	freshWorkspace,
}) => {
	const { company, agents, token } = freshWorkspace;
	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const fresh = (
		(await agentsRes.json()) as { data: Array<{ id: string; title: string; admin_status: string }> }
	).data;
	const agent = fresh.find((a) => a.admin_status === 'enabled') ?? fresh[0];

	await page.goto(`/companies/${company.slug}/agents/${agent.id}`);
	await dismissAiProviderModal(page);

	await page.getByRole('main').getByRole('link', { name: 'Settings' }).click();

	const titleInput = page.getByLabel('Title');
	await expect(titleInput).toBeVisible({ timeout: 15000 });
	await titleInput.fill(`${agent.title} Updated`);
	await page.getByRole('button', { name: 'Save Changes' }).click();

	await expect(page.getByText(`${agent.title} Updated`).first()).toBeVisible({ timeout: 15000 });
});

test('agent disable and enable lifecycle reflects in detail and team views', async ({
	page,
	freshWorkspace,
}) => {
	const { company, agents, token } = freshWorkspace;
	const enabledAgent =
		agents.find((a) => (a as { admin_status?: string }).admin_status === 'enabled') ?? agents[0];

	await page.goto(`/companies/${company.slug}/agents/${enabledAgent.id}`);
	await waitForPageLoad(page);

	await page.getByRole('main').getByRole('link', { name: 'Settings' }).click();

	await page.getByRole('button', { name: /Disable agent/i }).click();
	await expect(page.getByText('(disabled)')).toBeVisible({ timeout: 15000 });

	await page.getByRole('button', { name: /Enable agent/i }).click();
	await expect(page.getByText('(disabled)')).not.toBeVisible({ timeout: 15000 });
	await expect(page.getByRole('main').getByText('Idle')).toBeVisible({ timeout: 15000 });

	// Disable via API and verify it shows up on the team chart and detail page.
	await page.request.post(`/api/companies/${company.id}/agents/${enabledAgent.id}/disable`, {
		headers: { Authorization: `Bearer ${token}` },
	});

	await page.goto(`/companies/${company.slug}/agents`);
	await expect(page.getByText('You (Board)')).toBeVisible({ timeout: 15000 });

	await page.goto(`/companies/${company.slug}/agents/${enabledAgent.id}`);
	await expect(page.getByText('(disabled)')).toBeVisible({ timeout: 15000 });
});

test('long agent summary collapses to first line and toggles on click; short summary hides toggle', async ({
	page,
	freshWorkspace,
}) => {
	const { company, agents, token } = freshWorkspace;
	const longAgent = agents[0];
	const shortAgent = agents[1] ?? agents[0];

	const longSummary = Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of the description.`).join(
		' ',
	);
	await setAgentSummary(page, token, company.id, longAgent.id, longSummary);

	await page.goto(`/companies/${company.slug}/agents/${longAgent.id}`);

	const summary = page.getByTestId('agent-summary');
	await expect(summary).toBeVisible({ timeout: 15000 });
	const paragraph = summary.locator('p');
	await expect(paragraph).toContainText('Line 1');

	const expandButton = summary.getByRole('button', { name: 'Expand' });
	await expect(expandButton).toBeVisible();

	const collapsedHeight = await paragraph.evaluate((el) => el.clientHeight);
	const fullHeight = await paragraph.evaluate((el) => el.scrollHeight);
	expect(fullHeight).toBeGreaterThan(collapsedHeight);

	await expandButton.click();
	const collapseButton = summary.getByRole('button', { name: 'Collapse' });
	await expect(collapseButton).toBeVisible();
	expect(await paragraph.evaluate((el) => el.clientHeight)).toBeGreaterThan(collapsedHeight);

	await collapseButton.click();
	await expect(summary.getByRole('button', { name: 'Expand' })).toBeVisible();
	expect(await paragraph.evaluate((el) => el.clientHeight)).toBe(collapsedHeight);

	if (shortAgent !== longAgent) {
		await setAgentSummary(page, token, company.id, shortAgent.id, 'Short.');
		await page.goto(`/companies/${company.slug}/agents/${shortAgent.id}`);
		const shortSummary = page.getByTestId('agent-summary');
		await expect(shortSummary).toBeVisible({ timeout: 15000 });
		await expect(shortSummary.locator('p')).toContainText('Short.');
		await expect(shortSummary.getByRole('button', { name: /Expand|Collapse/ })).toHaveCount(0);
	}
});

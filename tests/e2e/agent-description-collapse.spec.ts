import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents } from './helpers';

async function setAgentSummary(
	page: import('@playwright/test').Page,
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

test('long summary collapses to first line and toggles on click', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as any).data[0];

	const longSummary = Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of the description.`).join(
		' ',
	);
	await setAgentSummary(page, token, company.id, agent.id, longSummary);

	await page.goto(`/companies/${company.slug}/agents/${agent.id}`);

	const summaryBlock = page.getByTestId('agent-summary');
	await expect(summaryBlock).toBeVisible({ timeout: 5000 });

	const paragraph = summaryBlock.locator('p');
	await expect(paragraph).toContainText('Line 1');

	const expandButton = summaryBlock.getByRole('button', { name: 'Expand' });
	await expect(expandButton).toBeVisible();

	const collapsedHeight = await paragraph.evaluate((el) => el.clientHeight);
	const fullHeight = await paragraph.evaluate((el) => el.scrollHeight);
	expect(fullHeight).toBeGreaterThan(collapsedHeight);

	await expandButton.click();

	const collapseButton = summaryBlock.getByRole('button', { name: 'Collapse' });
	await expect(collapseButton).toBeVisible();
	const expandedHeight = await paragraph.evaluate((el) => el.clientHeight);
	expect(expandedHeight).toBeGreaterThan(collapsedHeight);

	await collapseButton.click();
	await expect(summaryBlock.getByRole('button', { name: 'Expand' })).toBeVisible();
	const recollapsedHeight = await paragraph.evaluate((el) => el.clientHeight);
	expect(recollapsedHeight).toBe(collapsedHeight);
});

test('short single-line summary hides toggle', async ({ page }) => {
	await page.goto('/');
	await authenticate(page);

	const { company, token } = await createCompanyWithAgents(page);

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const agent = ((await agentsRes.json()) as any).data[0];

	await setAgentSummary(page, token, company.id, agent.id, 'Short.');

	await page.goto(`/companies/${company.slug}/agents/${agent.id}`);

	const summaryBlock = page.getByTestId('agent-summary');
	await expect(summaryBlock).toBeVisible({ timeout: 5000 });
	await expect(summaryBlock.locator('p')).toContainText('Short.');
	await expect(summaryBlock.getByRole('button', { name: /Expand|Collapse/ })).toHaveCount(0);
});

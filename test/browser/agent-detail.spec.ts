// Most agent-detail coverage now lives in the component tier
// (`packages/web/test/agent-detail.test.tsx`). This long-summary collapse test
// stays in Playwright because it asserts on real CSS-driven heights
// (`clientHeight` vs `scrollHeight`) which happy-dom doesn't compute.

import { expect, test } from './fixtures';

type Page = import('@playwright/test').Page;

async function setAgentSummary(
	page: Page,
	token: string,
	teamId: string,
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
				arguments: { team_id: teamId, agent_id: agentId, summary },
			},
		},
	});
	const body = await res.json();
	const payload = JSON.parse(body.result.content[0].text);
	expect(payload.updated).toBe(true);
}

test('long agent summary collapses to first line and toggles on click; short summary hides toggle', async ({
	page,
	freshWorkspace,
}) => {
	const { team, agents, token } = freshWorkspace;
	const longAgent = agents[0];
	const shortAgent = agents[1] ?? agents[0];

	const longSummary = Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of the description.`).join(
		' ',
	);
	await setAgentSummary(page, token, team.id, longAgent.id, longSummary);

	await page.goto(`/teams/${team.slug}/agents/${longAgent.id}`);

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
		await setAgentSummary(page, token, team.id, shortAgent.id, 'Short.');
		await page.goto(`/teams/${team.slug}/agents/${shortAgent.id}`);
		const shortSummary = page.getByTestId('agent-summary');
		await expect(shortSummary).toBeVisible({ timeout: 15000 });
		await expect(shortSummary.locator('p')).toContainText('Short.');
		await expect(shortSummary.getByRole('button', { name: /Expand|Collapse/ })).toHaveCount(0);
	}
});

import { expect, test } from '@playwright/test';
import { authenticate, createCompanyWithAgents } from './helpers';

test('log viewer preserves bottom-pinned scroll across expand/collapse cycles', async ({
	page,
}) => {
	await authenticate(page);
	const { company, token } = await createCompanyWithAgents(page);
	const headers = { Authorization: `Bearer ${token}` };

	const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const ceo = agents.find((a) => a.slug === 'ceo') ?? agents[0];

	const runId = '99999999-9999-9999-9999-000000000abc';
	const projectId = '11111111-1111-1111-1111-000000000abc';
	const issueId = '22222222-2222-2222-2222-000000000abc';

	const logLines = Array.from(
		{ length: 400 },
		(_, i) => `[synthetic] line ${i.toString().padStart(4, '0')} — log content for scroll test`,
	).join('\n');

	const runResponse = {
		id: runId,
		member_id: ceo.id,
		company_id: company.id,
		issue_id: issueId,
		issue_identifier: 'SCROLL-1',
		issue_title: 'Scroll Preservation Task',
		project_id: projectId,
		status: 'succeeded',
		started_at: new Date(Date.now() - 60_000).toISOString(),
		finished_at: new Date().toISOString(),
		exit_code: 0,
		error: null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: 0,
		invocation_command: null,
		log_text: logLines,
		working_dir: null,
		created_issues: [],
	};

	await page.route(`**/api/companies/*/agents/${ceo.id}/heartbeat-runs/${runId}`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: runResponse }),
		});
	});

	await page.goto(`/companies/${company.slug}/agents/${ceo.id}/executions/${runId}`);

	const inlineLog = page.getByTestId('run-log');
	await expect(inlineLog).toBeVisible({ timeout: 15_000 });
	await expect(inlineLog).toContainText('[synthetic]', { timeout: 10_000 });

	const readBottomOffset = (loc: ReturnType<typeof page.getByTestId>) =>
		loc.evaluate((el) => Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight));

	const setBottomOffset = (loc: ReturnType<typeof page.getByTestId>, offset: number) =>
		loc.evaluate((el, target) => {
			el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - target);
		}, offset);

	const initialBottomOffset = await readBottomOffset(inlineLog);

	const expandBtn = page.getByRole('button', { name: /expand log viewer/i });
	await expandBtn.click();
	const fullscreen = page.getByTestId('log-viewer-fullscreen');
	await expect(fullscreen).toBeVisible();

	expect(await readBottomOffset(fullscreen.getByTestId('run-log'))).toBe(initialBottomOffset);

	const collapseBtn = page.getByRole('button', { name: /collapse log viewer/i });
	await collapseBtn.click();
	await expect(fullscreen).toBeHidden();
	expect(await readBottomOffset(page.getByTestId('run-log'))).toBe(initialBottomOffset);

	const inlineScrollable = await inlineLog.evaluate((el) => el.scrollHeight > el.clientHeight);
	expect(inlineScrollable).toBe(true);

	await page.getByLabel('Auto-scroll').uncheck();
	const scrolledUpOffset = 200;
	await setBottomOffset(inlineLog, scrolledUpOffset);
	const actualScrolledOffset = await readBottomOffset(inlineLog);

	await expandBtn.click();
	await expect(fullscreen).toBeVisible();
	const fullscreenLog = fullscreen.getByTestId('run-log');
	const expanded = await readBottomOffset(fullscreenLog);
	expect(Math.abs(expanded - actualScrolledOffset)).toBeLessThan(20);

	await page.keyboard.press('Escape');
	await expect(fullscreen).toBeHidden();
	const restoredInline = await readBottomOffset(page.getByTestId('run-log'));
	expect(Math.abs(restoredInline - actualScrolledOffset)).toBeLessThan(20);
});

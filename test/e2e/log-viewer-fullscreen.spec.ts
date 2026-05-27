import { expect, test } from './fixtures';

test('log viewer preserves bottom-pinned scroll across expand/collapse cycles', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, agents } = sharedWorkspace;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const runId = '99999999-9999-9999-9999-000000000abc';
	const projectId = '11111111-1111-1111-1111-000000000abc';
	const taskId = '22222222-2222-2222-2222-000000000abc';

	const logLines = Array.from(
		{ length: 400 },
		(_, i) => `[synthetic] line ${i.toString().padStart(4, '0')} — log content for scroll test`,
	).join('\n');

	const runResponse = {
		id: runId,
		member_id: captain.id,
		team_id: team.id,
		task_id: taskId,
		task_identifier: 'SCROLL-1',
		task_title: 'Scroll Preservation Task',
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
		created_tasks: [],
	};

	await page.route(`**/api/teams/*/agents/${captain.id}/heartbeat-runs/${runId}`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: runResponse }),
		});
	});

	await page.goto(`/teams/${team.slug}/agents/${captain.id}/executions/${runId}`);

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

	const expandedBottom = await readBottomOffset(fullscreen.getByTestId('run-log'));
	expect(Math.abs(expandedBottom - initialBottomOffset)).toBeLessThan(20);

	const collapseBtn = page.getByRole('button', { name: /collapse log viewer/i });
	await collapseBtn.click();
	await expect(fullscreen).toBeHidden();
	const restoredBottom = await readBottomOffset(page.getByTestId('run-log'));
	expect(Math.abs(restoredBottom - initialBottomOffset)).toBeLessThan(20);

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

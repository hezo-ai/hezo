// Criteria #1, #2 and #5: most tests here are boundingBox/scrollHeight
// measurements (header wrap inside the viewport, icon centring, line-clamp) that
// happy-dom reports as 0, several only render at the 375px branch, and the
// streaming test needs the real clipboard permission plus a live run's log
// stream. Per-test rationale is inline below where a test turns on a specific
// criterion.
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
	authenticate,
	createProjectAndClearPlanning,
	createProjectReadyForAgents,
	getToken,
} from './helpers';

type CreatedProject = {
	id: string;
	slug: string;
	team_id: string;
	team_slug: string;
};

async function listProjectAgents(
	page: Page,
	projectSlug: string,
	token: string,
): Promise<Array<{ id: string; slug: string }>> {
	const res = await page.request.get(`/api/projects/${projectSlug}/agents`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	return ((await res.json()) as { data: Array<{ id: string; slug: string }> }).data;
}

async function waitForRunStatus(
	page: Page,
	projectSlug: string,
	taskId: string,
	token: string,
	target: 'running' | 'succeeded' | 'failed',
	timeoutMs = 180_000,
) {
	const headers = { Authorization: `Bearer ${token}` };
	const terminalFailures = new Set(['failed', 'cancelled', 'timed_out']);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await page.request.get(`/api/projects/${projectSlug}/tasks/${taskId}/latest-run`, {
			headers,
		});
		const body = (await res.json()) as { data: null | { id: string; status: string } };
		if (
			body.data &&
			(body.data.status === target || (target === 'running' && body.data.status === 'succeeded'))
		) {
			return body.data;
		}
		// When waiting for success, a terminal failure will never become success —
		// surface it immediately instead of polling until the timeout.
		if (body.data && target !== 'failed' && terminalFailures.has(body.data.status)) {
			throw new Error(
				`Latest run reached terminal status '${body.data.status}' while waiting for '${target}' (run ${body.data.id})`,
			);
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`Latest run did not reach status ${target} within ${timeoutMs}ms`);
}

test('run detail page streams synthetic agent logs', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await authenticate(page);
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const project = (await createProjectReadyForAgents(page, { id: '', slug: '' }, token, {
		name: 'Log Test Project',
		description: 'Test project.',
	})) as unknown as CreatedProject;

	const agents = await listProjectAgents(page, project.slug, token);
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Run Me',
			description: 'Synthetic test task',
			assignee_id: captain.id,
		},
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	await page.request.post(`/api/projects/${project.slug}/tasks/${task.id}/comments`, {
		headers,
		data: { content_type: 'text', content: { text: 'Please begin' } },
	});

	const run = await waitForRunStatus(page, project.slug, task.id, token, 'succeeded');

	await page.goto(`/projects/${project.slug}/agents/${captain.id}/executions/${run.id}`);

	await expect(page.getByRole('heading', { name: /Run \w{8}/i })).toBeVisible({ timeout: 15000 });

	const invocationToggle = page.getByRole('button', { name: /invocation/i });
	await expect(invocationToggle).toBeVisible({ timeout: 15000 });
	const invocationBody = page.getByTestId('run-invocation-body');
	await expect(invocationBody).toBeHidden();

	await invocationToggle.click();
	await expect(invocationBody).toBeVisible({ timeout: 2000 });

	await invocationToggle.click();
	await expect(invocationBody).toBeHidden();

	const logPane = page.getByTestId('run-log');
	await expect(logPane).toContainText('[synthetic] starting agent run', { timeout: 20_000 });
	await expect(logPane).toContainText('[synthetic] task complete', { timeout: 15000 });

	const durationValue = page.getByTestId('run-duration');
	await expect(durationValue).toHaveText(/^\d+(d\d+h\d+m|h\d+m|m)?\d*s$/);

	const copyBtn = page.getByRole('button', { name: /copy logs to clipboard/i });
	await expect(copyBtn).toBeVisible();
	await copyBtn.click();

	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
		.toContain('[synthetic] starting agent run');

	const taskLink = page.getByRole('link', {
		name: new RegExp(`^Task: ${task.identifier}`, 'i'),
	});
	await expect(taskLink).toBeVisible();
	await taskLink.click();
	// The link may carry a `#comment-<id>` scroll anchor to the run's inline
	// comment, so allow an optional hash after the identifier.
	await expect(page).toHaveURL(new RegExp(`/tasks/${task.identifier.toLowerCase()}(?:#.*)?$`));
});

test('task page renders completed run as a collapsed inline comment with summary', async ({
	page,
}) => {
	await authenticate(page);
	const token = await getToken(page);
	const headers = { Authorization: `Bearer ${token}` };

	const projectRes = await createProjectAndClearPlanning(page, '', token, {
		name: 'Collapsed Run Project',
		description: 'Test project.',
	});
	const project = (
		(await projectRes.json()) as { data: { id: string; slug: string; team_id: string } }
	).data;

	const agents = await listProjectAgents(page, project.slug, token);
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Collapsed Run Task', assignee_id: captain.id },
	});
	const task = ((await taskRes.json()) as { data: { id: string } }).data;

	const runId = '88888888-8888-8888-8888-888888888888';
	const startedAt = '2026-05-15T18:11:00Z';
	const finishedAt = '2026-05-15T18:12:17Z';
	const logText = Array.from({ length: 27 }, (_, i) => `[synthetic] line ${i + 1}`).join('\n');

	const runComment = {
		id: 'bbbb0000-0000-0000-0000-000000000001',
		task_id: task.id,
		content_type: 'run',
		content: { run_id: runId, agent_id: captain.id, agent_title: 'Product Lead' },
		chosen_option: null,
		created_at: startedAt,
		author_type: 'agent',
		author_name: 'Product Lead',
		author_member_id: captain.id,
	};

	await page.route('**/api/projects/*/tasks/*/comments**', async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [runComment] }),
		});
	});

	const runResponse = {
		id: runId,
		member_id: captain.id,
		team_id: project.team_id,
		task_id: task.id,
		task_identifier: null,
		task_title: null,
		project_id: project.id,
		status: 'succeeded',
		started_at: startedAt,
		finished_at: finishedAt,
		exit_code: 0,
		error: null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: 0,
		invocation_command: null,
		log_text: logText,
		working_dir: null,
		created_tasks: [],
	};

	await page.route(
		`**/api/projects/*/agents/${captain.id}/heartbeat-runs/${runId}`,
		async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ data: runResponse }),
			});
		},
	);

	await page.goto(`/projects/${project.slug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });

	const summary = runCommentEl.getByTestId('run-comment-summary');
	await expect(summary).toBeVisible({ timeout: 20_000 });
	await expect(summary).toContainText('succeeded');
	await expect(summary.getByTestId('run-comment-line-count')).toHaveText('27 lines');
	await expect(summary.getByTestId('run-comment-duration')).toHaveText('1m17s');

	await expect(runCommentEl.getByTestId('run-comment-log')).toHaveCount(0);
	await expect(runCommentEl.getByRole('button', { name: /copy logs to clipboard/i })).toHaveCount(
		0,
	);
	await expect(runCommentEl.getByRole('link', { name: /view full run/i })).toHaveCount(0);

	const header = runCommentEl.getByTestId('run-comment-header');
	await expect(header).toHaveAttribute('aria-expanded', 'false');
});

async function mockCompletedRun(page: Page, token: string, logTextOverride?: string) {
	const headers = { Authorization: `Bearer ${token}` };

	const projectRes = await createProjectAndClearPlanning(page, '', token, {
		name: 'Expand Run Project',
		description: 'Test project.',
	});
	const project = (
		(await projectRes.json()) as { data: { id: string; slug: string; team_id: string } }
	).data;

	const agents = await listProjectAgents(page, project.slug, token);
	const agentId = (agents.find((a) => a.slug === 'captain') ?? agents[0]).id;

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Expandable Run Task', assignee_id: agentId },
	});
	const task = ((await taskRes.json()) as { data: { id: string } }).data;

	const runId = '77777777-7777-7777-7777-777777777777';
	const startedAt = '2026-05-15T18:11:00Z';
	const finishedAt = '2026-05-15T18:12:17Z';
	const logText =
		logTextOverride ?? Array.from({ length: 27 }, (_, i) => `[synthetic] line ${i + 1}`).join('\n');

	const runComment = {
		id: 'cccc0000-0000-0000-0000-000000000001',
		task_id: task.id,
		content_type: 'run',
		content: { run_id: runId, agent_id: agentId, agent_title: 'Product Lead' },
		chosen_option: null,
		created_at: startedAt,
		author_type: 'agent',
		author_name: 'Product Lead',
		author_member_id: agentId,
	};

	await page.route('**/api/projects/*/tasks/*/comments**', async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [runComment] }),
		});
	});

	await page.route(`**/api/projects/*/agents/${agentId}/heartbeat-runs/${runId}`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				data: {
					id: runId,
					member_id: agentId,
					team_id: project.team_id,
					task_id: task.id,
					task_identifier: null,
					task_title: null,
					project_id: project.id,
					status: 'succeeded',
					started_at: startedAt,
					finished_at: finishedAt,
					exit_code: 0,
					error: null,
					input_tokens: 0,
					output_tokens: 0,
					cost_cents: 0,
					invocation_command: null,
					log_text: logText,
					working_dir: null,
					created_tasks: [],
				},
			}),
		});
	});

	return { task, runId, projectSlug: project.slug, agentId };
}

test('clicking the summary on a completed run expands the inline log', async ({ page }) => {
	await authenticate(page);
	const token = await getToken(page);

	const { task, runId, projectSlug, agentId } = await mockCompletedRun(page, token);

	await page.goto(`/projects/${projectSlug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });

	const header = runCommentEl.getByTestId('run-comment-header');
	await expect(header).toHaveAttribute('aria-expanded', 'false');
	await expect(runCommentEl.getByTestId('run-comment-log')).toHaveCount(0);

	await header.click();

	await expect(header).toHaveAttribute('aria-expanded', 'true');
	const log = runCommentEl.getByTestId('run-comment-log');
	await expect(log).toBeVisible();
	await expect(log).toContainText('[synthetic] line 1');
	await expect(log).toContainText('[synthetic] line 27');

	const runLink = runCommentEl.getByRole('link', { name: /view full run/i });
	await expect(runLink).toBeVisible();
	await expect(runLink).toHaveAttribute(
		'href',
		new RegExp(`/projects/${projectSlug}/agents/${agentId}/executions/${runId}$`),
	);

	await header.click();
	await expect(header).toHaveAttribute('aria-expanded', 'false');
	await expect(runCommentEl.getByTestId('run-comment-log')).toHaveCount(0);
});

test('completed run expansion works on mobile viewport', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 800 });
	await authenticate(page);
	const token = await getToken(page);

	const { task, projectSlug } = await mockCompletedRun(page, token);

	await page.goto(`/projects/${projectSlug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });

	const header = runCommentEl.getByTestId('run-comment-header');
	await header.click();

	const log = runCommentEl.getByTestId('run-comment-log');
	await expect(log).toBeVisible();
	await expect(log).toContainText('[synthetic] line 1');
});

// #1 (real CSS layout): asserts the summary row wraps INSIDE the viewport via
// boundingBox — happy-dom can't lay out the flex row, so this can only be
// verified in a real browser. Mobile width is the forcing function: the full
// header (title · status · duration · timestamp · chevron) is wider than a
// 375px row. The header <button> shrink-wraps to its content's max-content
// width (form controls ignore block auto-fill), so without max-w-full +
// flex-wrap the header would widen <main> past the viewport and the whole
// page would pan sideways; segments must flow to a second line instead.
test('completed run header wraps within the viewport when the log expands (mobile)', async ({
	page,
}) => {
	await page.setViewportSize({ width: 375, height: 800 });
	await authenticate(page);
	const token = await getToken(page);

	const { task, projectSlug } = await mockCompletedRun(page, token);

	await page.goto(`/projects/${projectSlug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });

	const header = runCommentEl.getByTestId('run-comment-header');
	const summary = header.getByTestId('run-comment-summary');
	await expect(summary).toBeVisible({ timeout: 20_000 });
	// The chevron is the only <svg> in the header (the status dot is a <span>).
	const chevron = header.locator('svg');

	const assertNoHorizontalOverflow = async () => {
		const headerBox = await header.boundingBox();
		const chevronBox = await chevron.boundingBox();
		if (!headerBox || !chevronBox) throw new Error('element has no bounding box');
		// The header (and its chevron) stay inside the 375px viewport…
		expect(headerBox.x).toBeGreaterThanOrEqual(0);
		expect(headerBox.x + headerBox.width).toBeLessThanOrEqual(375);
		expect(chevronBox.x + chevronBox.width).toBeLessThanOrEqual(375);
		// …and the page's scroll container never scrolls horizontally.
		const overflow = await page.evaluate(() => {
			const main = document.querySelector('main');
			return main ? main.scrollWidth - main.clientWidth : -1;
		});
		expect(overflow).toBe(0);
	};

	await assertNoHorizontalOverflow();

	// Opening the inline log grows the comment and can introduce a scrollbar that
	// narrows the row — the header must re-wrap inside it, never overflow.
	await header.click();
	await expect(runCommentEl.getByTestId('run-comment-log')).toBeVisible();
	await assertNoHorizontalOverflow();
});

// #1 (real CSS layout): the leading inline-event icon must share a vertical
// centre-line with the run summary's "<agent> run" label. The icon sits in a
// 26px slot while the label is a 16px text-xs line, so their centres only line
// up if the header row is also 26px tall — a layout fact happy-dom can't compute
// (boundingBox returns 0). Guards the regression where the icon sat ~5px low.
test('completed run inline icon is vertically centred on the summary label', async ({ page }) => {
	await authenticate(page);
	const token = await getToken(page);

	const { task, projectSlug } = await mockCompletedRun(page, token);

	await page.goto(`/projects/${projectSlug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });
	await expect(runCommentEl.getByTestId('run-comment-summary')).toBeVisible({ timeout: 20_000 });

	const commentItem = page
		.getByTestId('comment-item')
		.filter({ has: page.getByTestId('run-comment') })
		.first();
	const icon = commentItem.getByTestId('inline-event-icon');
	const label = runCommentEl.getByText('Product Lead run', { exact: true });

	const centerY = async (loc: Locator): Promise<number> => {
		const box = await loc.boundingBox();
		if (!box) throw new Error('element has no bounding box');
		return box.y + box.height / 2;
	};

	// Buggy layout left the icon centre ~5px below the label centre; aligned
	// centres sit within a sub-pixel. 2px cleanly separates the two states.
	const delta = Math.abs((await centerY(icon)) - (await centerY(label)));
	expect(delta).toBeLessThan(2);
});

// #1 (real CSS layout): asserts the formatted log body keeps the dark terminal
// surface (#0d1117) even with the app forced into light mode — a computed-style
// check happy-dom can't make. Runs on mobile to satisfy the mobile-layout rule.
test('task-page run log offers the formatted/raw switcher on a dark surface in light mode (mobile)', async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: 'light' });
	await page.addInitScript(() => localStorage.setItem('theme', 'light'));
	await page.setViewportSize({ width: 375, height: 800 });
	await authenticate(page);
	const token = await getToken(page);

	const { task, projectSlug } = await mockCompletedRun(page, token);

	await page.goto(`/projects/${projectSlug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });
	await runCommentEl.getByTestId('run-comment-header').click();

	const log = runCommentEl.getByTestId('run-comment-log');
	await expect(log).toBeVisible();

	// The formatted/raw switcher is available on task-page run logs, defaulting to
	// formatted.
	const formattedBtn = runCommentEl.getByRole('button', { name: 'Formatted view' });
	const rawBtn = runCommentEl.getByRole('button', { name: 'Raw logs' });
	await expect(formattedBtn).toBeVisible();
	await expect(rawBtn).toBeVisible();
	await expect(formattedBtn).toHaveAttribute('aria-pressed', 'true');

	// In light mode the formatted body still uses the dark terminal surface.
	const formattedBg = await log.evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(formattedBg).toBe('rgb(13, 17, 23)');

	// Raw stays on the same dark surface.
	await rawBtn.click();
	await expect(rawBtn).toHaveAttribute('aria-pressed', 'true');
	const rawBg = await runCommentEl
		.getByTestId('run-comment-log')
		.evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(rawBg).toBe('rgb(13, 17, 23)');
});

// #1 (real CSS layout): the formatted view clamps a tall thinking block to 3
// rendered lines and offers a Show more/less toggle. Whether the block overflows
// the clamp is a line-box measurement (scrollHeight vs a `line-clamp-3`
// clientHeight) — happy-dom reports 0 for both, so the toggle only ever appears
// in a real browser. A single long run-on `[thinking]` line (the untruncated
// server output — full reasoning is now recorded end-to-end) wraps well past 3
// lines at any width.
test('formatted view collapses a long thinking block behind a Show more/less toggle', async ({
	page,
}) => {
	await authenticate(page);
	const token = await getToken(page);

	const thinking = `[thinking] ${Array.from({ length: 140 }, () => 'deliberating').join(' ')}`;
	const logText = ['[session] model=claude-opus tools=3', thinking, '[done] success turns=1'].join(
		'\n',
	);

	const { task, projectSlug } = await mockCompletedRun(page, token, logText);

	await page.goto(`/projects/${projectSlug}/tasks/${task.id}`);

	const runCommentEl = page.getByTestId('run-comment').first();
	await expect(runCommentEl).toBeVisible({ timeout: 20_000 });
	await runCommentEl.getByTestId('run-comment-header').click();

	const log = runCommentEl.getByTestId('run-comment-log');
	await expect(log).toBeVisible();

	// Formatted view is the default; the thinking block renders inside it.
	const thinkingBlock = log.getByTestId('thinking-block');
	await expect(thinkingBlock).toBeVisible({ timeout: 15000 });

	const content = thinkingBlock.getByTestId('thinking-content');
	const toggle = thinkingBlock.getByTestId('thinking-toggle');

	// Collapsed by default: clamped to 3 lines, offering "Show more".
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveText(/show more/i);
	const clampedHeight = await content.evaluate((el) => el.clientHeight);

	// Expand → full height, toggle flips to "Show less".
	await toggle.click();
	await expect(toggle).toHaveText(/show less/i);
	const expandedHeight = await content.evaluate((el) => el.clientHeight);
	expect(expandedHeight).toBeGreaterThan(clampedHeight);

	// Collapse again restores the clamp exactly.
	await toggle.click();
	await expect(toggle).toHaveText(/show more/i);
	const recollapsedHeight = await content.evaluate((el) => el.clientHeight);
	expect(recollapsedHeight).toBe(clampedHeight);
});

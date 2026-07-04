import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, waitForPageLoad } from './helpers';

// The `mobile` Playwright project runs every *.mobile.spec.ts at a 390px
// viewport (see playwright.config.ts), so these assertions exercise the
// `<lg`/`<sm` responsive branches a desktop run never hits and happy-dom can't
// lay out (#1/#2 in the test-tier decision tree).

type CreatedProject = { id: string; slug: string; team_id: string };

async function createProjectAndTask(page: Page, token: string, name: string) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const projectRes = await createProjectAndClearPlanning(page, '', token, {
		name,
		description: 'Mobile layout test.',
	});
	const project = ((await projectRes.json()) as { data: CreatedProject }).data;

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const captain = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: {
			project_id: project.id,
			title: 'Mobile Task',
			description: 'Mobile description',
			assignee_id: captain.id,
		},
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;
	return { project, task, captainId: captain.id };
}

test.describe('Task detail — mobile layout (390px)', () => {
	test('comment input spans the full container width (avatar spacer hidden)', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { project, task } = await createProjectAndTask(page, token, 'Mobile Composer');

		await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
		await waitForPageLoad(page);

		const heading = page.getByRole('heading', { name: 'Mobile Task' });
		await expect(heading).toBeVisible({ timeout: 20000 });
		const composer = page.getByPlaceholder('Add a comment...');
		await expect(composer).toBeVisible();

		// With the 26px avatar spacer hidden on mobile, the textarea is flush with
		// the content column's left edge (same x as the task heading). With the
		// spacer it would sit ~36px (26px + gap) to the right.
		const headingBox = await heading.boundingBox();
		const composerBox = await composer.boundingBox();
		expect(headingBox).not.toBeNull();
		expect(composerBox).not.toBeNull();
		expect(Math.abs(composerBox!.x - headingBox!.x)).toBeLessThan(8);
	});

	test('right sidebar is a collapsed floating drawer the chevron opens', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { project, task } = await createProjectAndTask(page, token, 'Mobile Sidebar');

		await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
		await waitForPageLoad(page);

		await expect(page.getByRole('heading', { name: 'Mobile Task' })).toBeVisible({
			timeout: 20000,
		});

		const toggle = page.getByTestId('task-sidebar-toggle');
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');

		// Collapsed by default: the drawer is translated off the right edge, so its
		// left edge sits at (or beyond) the 390px viewport width.
		const rail = page.getByTestId('task-rail');
		const closedBox = await rail.boundingBox();
		expect(closedBox).not.toBeNull();
		expect(closedBox!.x).toBeGreaterThanOrEqual(360);

		// Tapping the chevron slides the drawer into view.
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');
		await expect
			.poll(async () => (await rail.boundingBox())?.x ?? 999, { timeout: 5000 })
			.toBeLessThan(200);
		await expect(page.getByTestId('task-sidebar')).toBeInViewport();
	});
});

test.describe('Task detail — document preview panel (mobile, 390px)', () => {
	// Seed a doc + a comment mentioning it, then assert the preview panel is its
	// own full-screen overlay layered ABOVE the meta side rail — and that closing
	// it does NOT reveal the meta sidebar (the drawer stays collapsed).
	async function createProjectTaskWithDocMention(page: Page, token: string) {
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const { project, task } = await createProjectAndTask(page, token, 'Mobile Doc Preview');

		const docRes = await page.request.put(`/api/projects/${project.slug}/docs/prd.md`, {
			headers,
			data: { content: '# Product Requirements\n\nAn unmistakable document body.' },
		});
		if (!docRes.ok()) throw new Error(`seed prd.md failed: ${docRes.status()}`);

		const commentRes = await page.request.post(
			`/api/projects/${project.slug}/tasks/${task.id}/comments`,
			{
				headers,
				data: { content_type: 'text', content: { text: 'Please review prd.md before we ship.' } },
			},
		);
		if (!commentRes.ok()) throw new Error(`seed comment failed: ${commentRes.status()}`);

		return { project, task };
	}

	test('doc preview is a full-screen overlay above the sidebar; closing it does not reveal the meta panel', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { project, task } = await createProjectTaskWithDocMention(page, token);

		await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Mobile Task' })).toBeVisible({
			timeout: 20000,
		});

		// The meta rail starts collapsed off-screen.
		const rail = page.getByTestId('task-rail');
		const toggle = page.getByTestId('task-sidebar-toggle');
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
		expect((await rail.boundingBox())?.x ?? 0).toBeGreaterThanOrEqual(360);

		// Open the doc from its mention in the comment.
		const mention = page.getByTestId('doc-mention-link').first();
		await expect(mention).toBeVisible({ timeout: 15000 });
		await mention.click();

		// The preview is its own full-screen overlay covering the viewport, and the
		// meta sidebar is not shown behind it.
		const preview = page.getByTestId('preview-panel');
		await expect(preview).toBeInViewport();
		const previewBox = await preview.boundingBox();
		expect(previewBox).not.toBeNull();
		expect(previewBox!.x).toBeLessThan(8);
		expect(previewBox!.width).toBeGreaterThan(360);
		await expect(page.getByTestId('task-sidebar')).not.toBeInViewport();

		// Close the preview — the bug was that this revealed the meta sidebar.
		await page.getByTestId('preview-close').click();
		await expect(preview).toHaveCount(0);
		await expect(page.getByTestId('task-sidebar')).not.toBeInViewport();
		// The meta drawer is still collapsed off-screen and the toggle untouched.
		expect((await rail.boundingBox())?.x ?? 0).toBeGreaterThanOrEqual(360);
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	});
});

// Render a completed run comment cheaply by mocking the comments + heartbeat-run
// responses — no real agent runtime needed (cribbed from agent-run-logs.spec.ts).
async function mockRunComment(page: Page, token: string) {
	const { project, task, captainId } = await createProjectAndTask(page, token, 'Mobile Run Meta');

	const runId = '99999999-9999-9999-9999-999999999999';
	const startedAt = '2026-05-15T18:11:00Z';
	const finishedAt = '2026-05-15T18:12:17Z';
	const logText = Array.from({ length: 27 }, (_, i) => `[synthetic] line ${i + 1}`).join('\n');

	const runComment = {
		id: 'dddd0000-0000-0000-0000-000000000001',
		task_id: task.id,
		content_type: 'run',
		content: {
			run_id: runId,
			agent_id: captainId,
			agent_title: 'Product Lead',
			actor_name: 'Admin',
		},
		chosen_option: null,
		created_at: startedAt,
		author_type: 'agent',
		author_name: 'Product Lead',
		author_member_id: captainId,
	};

	await page.route('**/api/projects/*/tasks/*/comments**', async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [runComment] }),
		});
	});

	await page.route(
		`**/api/projects/*/agents/${captainId}/heartbeat-runs/${runId}`,
		async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					data: {
						id: runId,
						member_id: captainId,
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
						cost_cents: 215,
						invocation_command: null,
						log_text: logText,
						working_dir: null,
						created_tasks: [],
					},
				}),
			});
		},
	);

	return { project, task };
}

test.describe('Agent-run meta — mobile (390px)', () => {
	test('post-run summary hides line count, cost, and actor; keeps status + duration', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { project, task } = await mockRunComment(page, token);

		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);

		const runCommentEl = page.getByTestId('run-comment').first();
		await expect(runCommentEl).toBeVisible({ timeout: 20_000 });

		const summary = runCommentEl.getByTestId('run-comment-summary');
		await expect(summary).toBeVisible({ timeout: 20_000 });
		await expect(summary).toContainText('succeeded');
		await expect(summary.getByTestId('run-comment-duration')).toBeVisible();

		// Freed up on mobile.
		await expect(summary.getByTestId('run-comment-line-count')).toBeHidden();
		await expect(summary.getByTestId('run-comment-cost')).toBeHidden();
		await expect(runCommentEl.getByTestId('run-comment-actor')).toBeHidden();
	});

	test('expanded log top bar hides the status label, "Logs" word, and line count', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { project, task } = await mockRunComment(page, token);

		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);

		const runCommentEl = page.getByTestId('run-comment').first();
		await expect(runCommentEl).toBeVisible({ timeout: 20_000 });

		await runCommentEl.getByTestId('run-comment-header').click();
		const log = runCommentEl.getByTestId('run-comment-log');
		await expect(log).toBeVisible();

		// Scope to the log region so we read the toolbar's own label/count, not the
		// (also-hidden) summary line count that lives in the header above it.
		const logRegion = runCommentEl.locator('[id^="run-comment-log-"]');
		// On mobile the toolbar is anchored by the status dot alone; the agent
		// status label, the redundant "Logs" word, and the line count are all
		// hidden to free up horizontal room for the toolbar buttons.
		await expect(logRegion.getByText(/Product Lead.*succeeded/)).toBeHidden();
		await expect(logRegion.getByText('Logs', { exact: true })).toBeHidden();
		await expect(logRegion.getByText('27 lines', { exact: true })).toBeHidden();
	});
});

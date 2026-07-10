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

		// A review comment on the doc enables the "Action this review" / "Clear"
		// toolbar buttons (they're disabled at count 0).
		const reviewRes = await page.request.post(
			`/api/projects/${project.slug}/docs/prd.md/review-comments`,
			{
				headers,
				data: { quote: 'unmistakable document body', occurrence: 0, comment: 'Tighten this.' },
			},
		);
		if (!reviewRes.ok()) throw new Error(`seed review comment failed: ${reviewRes.status()}`);

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

	test('review-toolbar dialogs open ABOVE the full-screen preview panel', async ({
		page,
		freshWorkspace,
	}) => {
		// Regression: below lg the preview panel is `fixed inset-0 z-[60]` and opaque,
		// while the shared Dialog used to sit at z-50. Dialogs opened from the panel's
		// review toolbar (help "?", "Action this review") scroll-locked the page but
		// were painted over by the panel — present in the DOM, invisible on screen.
		// This is a real-CSS-stacking assertion happy-dom can't make (#1 in the tier
		// decision tree), so it lives in Playwright. It fails on z-50 and holds on the
		// raised z-[80]/z-[90] dialog layer.
		const { token } = freshWorkspace;
		const { project, task } = await createProjectTaskWithDocMention(page, token);

		await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Mobile Task' })).toBeVisible({
			timeout: 20000,
		});

		const mention = page.getByTestId('doc-mention-link').first();
		await expect(mention).toBeVisible({ timeout: 15000 });
		await mention.click();
		await expect(page.getByTestId('preview-panel')).toBeInViewport();

		// Assert the element painted at a dialog's centre actually belongs to that
		// dialog — the direct test of "not occluded by the z-[60] panel". A visible
		// check alone wouldn't catch occlusion (the dialog is technically visible,
		// just covered).
		async function expectDialogOnTop(locator: ReturnType<Page['locator']>) {
			await expect(locator).toBeVisible();
			const box = await locator.boundingBox();
			expect(box).not.toBeNull();
			if (!box) return;
			const cx = Math.round(box.x + box.width / 2);
			const cy = Math.round(box.y + box.height / 2);
			const dialogId = await locator.evaluate((el) => {
				el.setAttribute('data-occlusion-probe', '1');
				return true;
			});
			expect(dialogId).toBe(true);
			const topmostIsInsideDialog = await page.evaluate(
				({ x, y }) => {
					const el = document.elementFromPoint(x, y);
					return !!el?.closest('[data-occlusion-probe="1"]');
				},
				{ x: cx, y: cy },
			);
			expect(topmostIsInsideDialog).toBe(true);
			await locator.evaluate((el) => el.removeAttribute('data-occlusion-probe'));
		}

		// 1) The help "?" dialog.
		await page.getByTestId('review-help').click();
		const helpDialog = page.getByRole('dialog').filter({ hasText: 'How document review works' });
		await expectDialogOnTop(helpDialog);
		await page.getByTestId('dialog-close').click();
		await expect(helpDialog).toHaveCount(0);

		// 2) The "Action this review" finalisation dialog.
		await page.getByTestId('review-action-open').click();
		await expectDialogOnTop(page.getByTestId('action-review-dialog'));
	});
});

test.describe('Comment header — mobile (narrow viewport)', () => {
	// The comment header (author · timestamp · "replying to …" · copy) must stay
	// on a single row on a narrow phone. The timestamp is the segment that
	// truncates with an ellipsis to make room; its full value is revealed in a
	// tooltip on tap. This needs a real layout pass (#1/#2 in the tier tree), so
	// it lives in Playwright.
	async function seedReply(page: Page, token: string, projectSlug: string, taskId: string) {
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const parentRes = await page.request.post(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments`,
			{ headers, data: { content_type: 'text', content: { text: 'Parent comment.' } } },
		);
		const parent = ((await parentRes.json()) as { data: { id: string } }).data;
		const replyRes = await page.request.post(
			`/api/projects/${projectSlug}/tasks/${taskId}/comments`,
			{
				headers,
				data: {
					content_type: 'text',
					content: { text: 'A reply that carries a replying-to indicator in its header.' },
					parent_comment_id: parent.id,
				},
			},
		);
		if (!replyRes.ok()) throw new Error(`seed reply failed: ${replyRes.status()}`);
	}

	test('header stays on one row; timestamp truncates and reveals the full value on tap', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { project, task } = await createProjectAndTask(page, token, 'Mobile Comment Header');
		await seedReply(page, token, project.slug, task.id);

		// 320px — a small phone — to force the header to run out of room so the
		// truncation branch actually fires.
		await page.setViewportSize({ width: 320, height: 800 });
		await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
		await waitForPageLoad(page);
		await expect(page.getByRole('heading', { name: 'Mobile Task' })).toBeVisible({
			timeout: 20000,
		});

		// Scope to the reply's header — it's the comment carrying a "replying to" link.
		const replyItem = page
			.getByTestId('comment-item')
			.filter({ has: page.getByTestId('replying-to') });
		await expect(replyItem).toBeVisible({ timeout: 15000 });
		const timestamp = replyItem.getByTestId('comment-timestamp-link');
		const author = replyItem.getByTestId('comment-author');
		const replyingTo = replyItem.getByTestId('replying-to');
		await expect(timestamp).toBeVisible();

		// The page never scrolls horizontally.
		const overflow = await page.evaluate(() => {
			const main = document.querySelector('main');
			return main ? main.scrollWidth - main.clientWidth : -1;
		});
		expect(overflow).toBe(0);

		// Author, timestamp, and "replying to" all sit on the SAME row — their
		// vertical spans overlap (the header did not wrap onto a second line).
		const authorBox = await author.boundingBox();
		const tsBox = await timestamp.boundingBox();
		const replyBox = await replyingTo.boundingBox();
		if (!authorBox || !tsBox || !replyBox) throw new Error('Missing layout box');
		const sameRow = (a: typeof authorBox, b: typeof tsBox) =>
			a.y < b.y + b.height && b.y < a.y + a.height;
		expect(sameRow(authorBox, tsBox)).toBe(true);
		expect(sameRow(authorBox, replyBox)).toBe(true);

		// The timestamp is the segment that gave way: it is clipped to an ellipsis
		// (rendered narrower than its full text), yet its full value is intact in
		// the DOM for the tooltip.
		const truncated = await timestamp.evaluate((el) => el.scrollWidth > el.clientWidth);
		expect(truncated).toBe(true);
		expect(tsBox.x + tsBox.width).toBeLessThanOrEqual(320);
		const full = ((await timestamp.textContent()) ?? '').trim();
		expect(full.length).toBeGreaterThan(0);

		// Tapping the timestamp reveals the full date/time in a tooltip (Radix
		// tooltips never open on tap, so the component drives `open` from its own
		// touchstart handler).
		await timestamp.dispatchEvent('touchstart');
		const tooltip = page.getByRole('tooltip');
		await expect(tooltip).toBeVisible({ timeout: 5000 });
		expect(((await tooltip.textContent()) ?? '').trim()).toBe(full);
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
		public_id: 'runmock01',
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

	test('run header wraps on a narrow viewport instead of widening the page', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { project, task } = await mockRunComment(page, token);

		// 375px (not the project default 390) — the width the overflow regression
		// was reported at: the <button> header shrink-wraps to its content's
		// max-content width, so without max-w-full + flex-wrap the whole <main>
		// column scrolled horizontally.
		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);

		const header = page.getByTestId('run-comment-header');
		await expect(header).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId('run-comment-summary')).toBeVisible();

		// The page never scrolls horizontally…
		const overflow = await page.evaluate(() => {
			const main = document.querySelector('main');
			return main ? main.scrollWidth - main.clientWidth : -1;
		});
		expect(overflow).toBe(0);

		// …because the header stays within the viewport (wrapping its segments),
		// with the timestamp fully visible rather than clipped.
		const headerBox = await header.boundingBox();
		if (!headerBox) throw new Error('Missing layout box');
		expect(headerBox.x + headerBox.width).toBeLessThanOrEqual(375);
		const timestamp = header.getByTestId('comment-timestamp-link');
		await expect(timestamp).toBeVisible();
		const tsBox = await timestamp.boundingBox();
		if (!tsBox) throw new Error('Missing layout box');
		expect(tsBox.x + tsBox.width).toBeLessThanOrEqual(375);
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

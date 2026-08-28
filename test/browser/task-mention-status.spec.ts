// Real Chromium (decision tree #1 + #5-adjacent): the status pill lives inside a
// Radix tooltip that only mounts its content (a portal on document.body) on a real
// pointer hover, and the "struck through" assertion reads the computed
// text-decoration off the laid-out link — neither the hover-driven portal nor
// getComputedStyle works under happy-dom, so this slice stays in the browser tier.
// (The status→DOM threading and the strikethrough class toggle are covered cheaply
// by packages/web/test/markdown-prose-mentions.test.tsx.)

import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

async function createTaskViaApi(
	page: Page,
	projectSlug: string,
	token: string,
	data: { project_id: string; title: string; assignee_slug?: string; description?: string },
): Promise<{ id: string; identifier: string }> {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	// A task requires an assignee; the Blank-templated project has a Captain.
	const res = await page.request.post(`/api/projects/${projectSlug}/tasks`, {
		headers,
		data: { assignee_slug: 'captain', ...data },
	});
	if (!res.ok()) throw new Error(`createTaskViaApi failed — ${res.status()} ${await res.text()}`);
	return ((await res.json()) as { data: { id: string; identifier: string } }).data;
}

test.describe('Task mention — status pill tooltip & terminal strikethrough', () => {
	test('a mention of a cancelled task shows a status pill on hover and strikes through the link', async ({
		page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		await page.setViewportSize({ width: 1280, height: 720 });

		const proj = await createProjectAndClearPlanning(page, '', token, {
			name: uniqueName('Mention Status'),
			description: 'Mention status pill spec.',
		});

		// Target is set terminal (cancelled is unguarded, so closing is deterministic
		// with no run-race), then referenced from the source task's description, which
		// renders through markdown-prose and linkifies the identifier.
		const target = await createTaskViaApi(page, proj.slug, token, {
			project_id: proj.id,
			title: 'Cancelled target task',
		});
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		// Cancelling is unguarded, but it is not the last word: creating a task with
		// an assignee fires a wakeup, and `createHeartbeatRun` flips the task to
		// `in_progress` when the run row lands. Under load that flip arrives *after*
		// this PATCH and quietly undoes it - the mention then resolves as
		// non-terminal, so the link loses its strikethrough and the tooltip renders
		// with no status pill. Re-assert until the cancel is the state that stuck.
		const targetPath = `/api/projects/${proj.slug}/tasks/${target.identifier.toLowerCase()}`;
		await expect(async () => {
			const patchRes = await page.request.patch(targetPath, {
				headers,
				data: { status: 'cancelled' },
			});
			expect(patchRes.ok()).toBeTruthy();
			const read = await page.request.get(targetPath, { headers });
			const task = ((await read.json()) as { data: { status: string; has_active_run: boolean } })
				.data;
			// Both, and the second is the one that makes it stick: a run still in
			// flight flips the status again the moment its row lands, so a cancel
			// that has merely been *written* is not yet the state the page will see.
			expect(task.has_active_run).toBe(false);
			expect(task.status).toBe('cancelled');
		}).toPass({ timeout: 30_000 });

		const source = await createTaskViaApi(page, proj.slug, token, {
			project_id: proj.id,
			title: 'Source task',
			description: `Superseded by ${target.identifier}, see there.`,
		});

		await page.goto(`/projects/${proj.slug}/tasks/${source.identifier.toLowerCase()}`);
		await waitForPageLoad(page);

		const mention = page.getByTestId('task-mention-link');
		await expect(mention).toBeVisible({ timeout: 20_000 });
		await expect(mention).toContainText(target.identifier);

		// Terminal → the link text is struck through. toHaveCSS auto-retries so it
		// can't race the dev server's async stylesheet injection. Assert before
		// hovering: MENTION_CLASSES' hover:underline flips text-decoration-line to
		// underline while the pointer is over the link.
		await expect(mention).toHaveCSS('text-decoration-line', 'line-through');

		// Hover opens the Radix tooltip; the status pill lives inside its portal
		// content. Scope to the role="tooltip" panel — Radix also renders a hidden
		// aria duplicate of the content that carries the same testId.
		const tooltip = page.getByRole('tooltip');
		const pill = tooltip.getByTestId('task-mention-status-pill');
		// Re-hover until the tooltip is actually up, the same way the cancel above
		// is re-asserted until it sticks. One `hover()` fires a single pointerenter,
		// and there is live traffic behind this page - the run row and its two
		// events land while the test is standing here. A re-render between that
		// pointerenter and Radix's 150ms open delay swallows it, and nothing
		// re-issues the event, so a plain hover plus a long wait can never recover:
		// it fails having never opened the tooltip at all. Leaving the link and
		// coming back is what produces a fresh pointerenter.
		await expect(async () => {
			await page.mouse.move(0, 0);
			await mention.hover();
			await expect(pill).toBeVisible({ timeout: 3_000 });
		}).toPass({ timeout: 30_000 });
		await expect(pill).toHaveText('Cancelled');
		// The tooltip prefixes the task title with the bold task identifier.
		await expect(tooltip).toContainText(
			`${target.identifier.toUpperCase()}: Cancelled target task`,
		);
	});
});

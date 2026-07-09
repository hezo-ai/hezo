// These tests stay in Playwright because they exercise behavior happy-dom
// doesn't model (see AGENTS.md decision tree):
//   1. Real CSS layout — the composer textarea auto-grows/shrinks by reading
//      `scrollHeight`/`clientHeight`, and the fullscreen editor is measured with
//      `boundingBox()`. happy-dom reports 0 for all of these.
//   2. Viewport-conditional layout — the fullscreen editor at a 375px mobile
//      viewport.

import { expect, test } from './fixtures';
import {
	createProjectAndClearPlanning,
	uniqueName,
	waitForAgentIdle,
	waitForPageLoad,
} from './helpers';

type Page = import('@playwright/test').Page;

async function createProjectAndTask(page: Page, token: string) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const projRes = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Composer Project'),
		description: 'Test project.',
	});
	const project = ((await projRes.json()) as any).data;

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const agent = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Composer Test Task', assignee_id: agent.id },
	});
	const task = ((await taskRes.json()) as any).data;

	await waitForAgentIdle(page, project.team_slug, agent.id, token);

	return { token, project, task, agent, headers };
}

test.describe('Task comment composer', () => {
	test('inline textarea auto-grows with content, then caps and scrolls', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { task, project } = await createProjectAndTask(page, sharedWorkspace.token);
		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		const composer = page.getByPlaceholder('Add a comment...');
		await expect(composer).toBeVisible({ timeout: 20_000 });

		const height = () => composer.evaluate((el) => (el as HTMLTextAreaElement).clientHeight);
		const baseHeight = await height();

		// A few lines grow the box beyond its single-row floor.
		await composer.fill(Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n'));
		await expect.poll(height).toBeGreaterThan(baseHeight);
		const grownHeight = await height();

		// Far more lines than the `max-h-[40vh]` cap: the box stops growing and the
		// content overflows into a scroll region instead of pushing the page.
		await composer.fill(Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n'));
		const viewport = page.viewportSize();
		const cap = Math.round((viewport?.height ?? 0) * 0.4);
		await expect
			.poll(() => composer.evaluate((el) => (el as HTMLTextAreaElement).clientHeight))
			.toBeLessThanOrEqual(cap + 4);
		expect(await height()).toBeGreaterThanOrEqual(grownHeight);
		const scrolls = await composer.evaluate(
			(el) => (el as HTMLTextAreaElement).scrollHeight > (el as HTMLTextAreaElement).clientHeight,
		);
		expect(scrolls).toBe(true);

		// Clearing shrinks it back toward the floor.
		await composer.fill('');
		await expect.poll(height).toBeLessThan(grownHeight);
	});

	test('expand fills the viewport with the textarea taking most of the space', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { task, project } = await createProjectAndTask(page, sharedWorkspace.token);
		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		await page.getByTestId('comment-expand').click();

		const dialog = page.getByTestId('comment-composer-fullscreen');
		await expect(dialog).toBeVisible();

		const viewport = page.viewportSize();
		const dialogBox = await dialog.boundingBox();
		expect(dialogBox).not.toBeNull();
		// Fills the viewport (desktop `sm:inset-4` leaves a small margin).
		expect(dialogBox!.height).toBeGreaterThan((viewport?.height ?? 0) * 0.8);
		expect(dialogBox!.width).toBeGreaterThan((viewport?.width ?? 0) * 0.8);

		// The textarea takes most of the vertical space, and the auxiliary controls
		// stay visible alongside it.
		const composer = dialog.getByPlaceholder('Add a comment...');
		const composerBox = await composer.boundingBox();
		expect(composerBox).not.toBeNull();
		expect(composerBox!.height).toBeGreaterThan(dialogBox!.height * 0.4);
		await expect(dialog.getByTestId('comment-attachment-upload-button')).toBeVisible();
		await expect(dialog.getByTestId('wake-preview')).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();

		// The dialog's built-in close returns the composer inline.
		await dialog.getByTestId('dialog-close').click();
		await expect(dialog).toHaveCount(0);
	});

	test('expand works on a mobile viewport', async ({ sharedPage: page, sharedWorkspace }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		const { task, project } = await createProjectAndTask(page, sharedWorkspace.token);
		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		// The toggle is present on mobile (unlike the create-task dialog / CEO chat).
		const expand = page.getByTestId('comment-expand');
		await expect(expand).toBeVisible({ timeout: 20_000 });
		await expand.click();

		const dialog = page.getByTestId('comment-composer-fullscreen');
		await expect(dialog).toBeVisible();
		const box = await dialog.boundingBox();
		expect(box).not.toBeNull();
		// `fixed inset-0` fills the whole screen on mobile.
		expect(box!.height).toBeGreaterThan(812 * 0.9);
		expect(box!.width).toBeGreaterThan(375 * 0.9);

		const composer = dialog.getByPlaceholder('Add a comment...');
		const composerBox = await composer.boundingBox();
		expect(composerBox).not.toBeNull();
		expect(composerBox!.height).toBeGreaterThan(box!.height * 0.4);
		await expect(dialog.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
	});
});

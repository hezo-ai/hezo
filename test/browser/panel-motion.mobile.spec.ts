import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

// Real-CSS-engine + viewport-conditional assertion (testing decision tree, points
// 1 & 2). The document panel's open/close motion is a keyframe animation whose
// travel is a media-query-scoped custom property: below lg it slides its whole
// width in from the right edge, at lg+ the widening grid track carries the
// movement and it only fades. happy-dom applies no stylesheet, runs no keyframes
// and evaluates no media queries, so `getComputedStyle().animationName` and the
// slide itself can only be observed in a real browser at a real viewport. The
// mount/unmount wiring behind it is unit-covered by
// packages/web/test/resizable-split.test.tsx.

const DOC = 'prd.md';

async function seedTaskWithDocMention(page: Page, token: string) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const project = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Panel Motion'),
		description: 'Panel open/close motion test.',
	});

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const assigneeId = (agents.find((a) => a.slug === 'captain') ?? agents[0]).id;

	const docRes = await page.request.put(`/api/projects/${project.slug}/docs/${DOC}`, {
		headers,
		data: { content: '# Product Requirements\n\nAn unmistakable document body.' },
	});
	expect(docRes.ok()).toBe(true);

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Motion Task', assignee_id: assigneeId },
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	const commentRes = await page.request.post(
		`/api/projects/${project.slug}/tasks/${task.id}/comments`,
		{
			headers,
			data: { content_type: 'text', content: { text: `Please review ${DOC} before we ship.` } },
		},
	);
	expect(commentRes.ok()).toBe(true);

	return { projectSlug: project.slug, taskId: task.identifier.toLowerCase() };
}

async function openTask(page: Page, projectSlug: string, taskId: string): Promise<void> {
	await page.goto(`/projects/${projectSlug}/tasks/${taskId}`);
	await waitForPageLoad(page);
	await expect(page.getByRole('heading', { name: 'Motion Task' })).toBeVisible({ timeout: 20000 });
}

const openDoc = async (page: Page): Promise<void> => {
	const mention = page.getByTestId('doc-mention-link').first();
	await expect(mention).toBeVisible({ timeout: 15000 });
	await mention.click();
};

/** The animation the browser has actually resolved for the panel. */
const motionOf = (page: Page) =>
	page.getByTestId('preview-panel').evaluate((el) => {
		const s = getComputedStyle(el);
		return {
			name: s.animationName,
			duration: s.animationDuration,
			easing: s.animationTimingFunction,
			travel: s.getPropertyValue('--panel-travel').trim(),
		};
	});

test.describe('Side panel motion — mobile (390px)', () => {
	test('the document panel slides in from the right edge and settles', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { projectSlug, taskId } = await seedTaskWithDocMention(page, token);
		await openTask(page, projectSlug, taskId);

		await openDoc(page);
		const panel = page.getByTestId('preview-panel');
		await expect(panel).toBeVisible();

		// The declared animation is readable whether or not it has finished, so this
		// is a straight assertion rather than a race against the clock.
		expect(await motionOf(page)).toEqual({
			name: 'panel-enter',
			duration: '0.3s',
			easing: 'ease-in-out',
			travel: '100%', // full-width travel below lg; lg+ overrides this to 0px
		});
		// The token the whole system reads resolves on the page, not just in source.
		expect(
			await page.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue('--panel-motion').trim(),
			),
		).toBe('300ms');

		await expect
			.poll(async () => (await panel.boundingBox())?.x ?? 999, { timeout: 5000 })
			.toBeLessThan(8);
	});

	test('closing plays the exit before the panel leaves the DOM', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { projectSlug, taskId } = await seedTaskWithDocMention(page, token);
		await openTask(page, projectSlug, taskId);

		await openDoc(page);
		const panel = page.getByTestId('preview-panel');
		await expect(panel).toBeVisible();
		await expect.poll(async () => (await panel.boundingBox())?.x ?? 999).toBeLessThan(8);

		// Start watching before the click, so the exit cannot finish between the two.
		const sawExit = page.evaluate(
			() =>
				new Promise<boolean>((resolve) => {
					const started = performance.now();
					const tick = () => {
						const el = document.querySelector('[data-testid="preview-panel"]');
						if (el && getComputedStyle(el).animationName === 'panel-exit') return resolve(true);
						if (performance.now() - started > 4000) return resolve(false);
						requestAnimationFrame(tick);
					};
					tick();
				}),
		);
		await page.getByTestId('preview-close').click();
		expect(await sawExit).toBe(true);

		// It is inert while it plays, and gone once it has.
		await expect(panel).toHaveCount(0, { timeout: 5000 });
	});

	test('reduced motion opens the panel with no animation at all', async ({
		page,
		freshWorkspace,
	}) => {
		const { token } = freshWorkspace;
		const { projectSlug, taskId } = await seedTaskWithDocMention(page, token);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await openTask(page, projectSlug, taskId);

		await openDoc(page);
		const panel = page.getByTestId('preview-panel');
		await expect(panel).toBeVisible();

		expect((await motionOf(page)).name).toBe('none');
		// No poll: the point is that it never travelled, so it is already at rest on
		// the first read.
		expect((await panel.boundingBox())?.x ?? 999).toBeLessThan(8);
	});
});

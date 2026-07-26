// Viewport-conditional stacking assertion (testing decision tree, points 1 & 2):
// below lg the task-detail preview panel is a full-screen `fixed inset-0 z-[60]`
// overlay, and the download menu is a Radix popover portalled onto document.body.
// Whether the menu paints *above* that overlay is a real-compositing question —
// happy-dom neither resolves the media query that makes the panel full-screen nor
// hit-tests painted layers, so a component test sees an "attached and visible"
// menu either way (it was, in fact, invisible under the panel at z-50). The
// download behaviour itself — which formats, what bytes, what filename — is
// covered by packages/web/test/document-download.test.tsx on all three surfaces.

import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

const DOC = 'download-me.md';
const DOC_CONTENT = ['# Download me', '', 'Body text for the download menu spec.'].join('\n');

test('the preview panel download menu paints above the full-screen mobile panel', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { token } = sharedWorkspace;
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	// Mobile viewport: the panel becomes the fixed inset-0 z-[60] overlay.
	await page.setViewportSize({ width: 390, height: 844 });

	const project = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Doc Preview Download'),
		description: 'Preview panel download menu test.',
	});

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const assigneeId = (agents.find((a) => a.slug === 'captain') ?? agents[0]).id;

	const docRes = await page.request.put(`/api/projects/${project.slug}/docs/${DOC}`, {
		headers,
		data: { content: DOC_CONTENT },
	});
	expect(docRes.ok()).toBe(true);

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Read the doc', assignee_id: assigneeId },
	});
	expect(taskRes.ok()).toBe(true);
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	const commentRes = await page.request.post(
		`/api/projects/${project.slug}/tasks/${task.id}/comments`,
		{ headers, data: { content_type: 'text', content: { text: `Please read ${DOC} today.` } } },
	);
	expect(commentRes.ok()).toBe(true);

	await page.goto(`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}`);
	await waitForPageLoad(page);

	await page.getByTestId('doc-mention-link').first().click();
	await expect(page.getByTestId('preview-panel')).toBeVisible();

	// The whole header cluster still fits the 390px row — the trigger is inside
	// the viewport, not pushed off the right edge by the other icon actions.
	const trigger = page.getByTestId('doc-download');
	await expect(trigger).toBeVisible();
	const triggerBox = await trigger.boundingBox();
	expect(triggerBox).not.toBeNull();
	expect(triggerBox?.x).toBeGreaterThanOrEqual(0);
	expect((triggerBox?.x ?? 0) + (triggerBox?.width ?? 0)).toBeLessThanOrEqual(390);

	await trigger.click();
	const option = page.getByTestId('doc-download-markdown');
	await expect(option).toBeVisible();

	// The real check: hit-test the option's centre. `toBeVisible()` passes on an
	// element that is fully painted over, so ask the browser what is actually on
	// top there — it must be the option (or something inside it).
	const box = await option.boundingBox();
	expect(box).not.toBeNull();
	const onTop = await page.evaluate(
		({ x, y }) => {
			const el = document.elementFromPoint(x, y);
			return !!el?.closest('[data-testid="doc-download-markdown"]');
		},
		{ x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 },
	);
	expect(onTop).toBe(true);
});

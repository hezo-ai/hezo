// These tests stay in Playwright because they exercise behavior happy-dom
// doesn't model (see AGENTS.md decision tree):
//   1. Real CSS layout — which side a dropdown panel opens on is decided from
//      live client rects (`getBoundingClientRect` against the viewport and the
//      panel's clipping scroll ancestor), and the assertion is that the panel
//      does not cross the viewport edge. happy-dom reports 0 for every box, so
//      the placement there always resolves to the same side; the arithmetic
//      itself is covered by packages/web/test/panel-placement.test.ts.
//   2. Viewport-conditional layout — the `mobile` project runs *.mobile.spec.ts
//      at 390x844, the viewport where a composer pinned to the bottom of the
//      page has the least room below it.

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
	createProjectAndClearPlanning,
	uniqueName,
	waitForPageLoad,
	waitForStableBox,
} from './helpers';

/** The mention picker's design cap (`PANEL_MAX_HEIGHT_PX` in mention-picker.tsx). */
const PICKER_MAX_HEIGHT = 256;

type CreatedProject = { id: string; slug: string; team_id: string };
type CreatedTask = { id: string; identifier: string };

async function createProjectWithTalkativeTask(page: Page, token: string) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

	const projectRes = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Dropdown Placement'),
		description: 'Dropdown flip placement test.',
	});
	const project = ((await projectRes.json()) as { data: CreatedProject }).data;

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const agent = agents.find((a) => a.slug === 'captain') ?? agents[0];

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Placement Test Task', assignee_id: agent.id },
	});
	const task = ((await taskRes.json()) as { data: CreatedTask }).data;

	// Enough comments to push the composer to the bottom of a scrolling page —
	// which is the condition the flip exists for. The guard assertion in the test
	// fails loudly if this ever stops being enough.
	await Promise.all(
		Array.from({ length: 12 }, (_, i) =>
			page.request.post(`/api/projects/${project.slug}/tasks/${task.id}/comments`, {
				headers,
				data: { content_type: 'text', content: { text: `placement filler comment ${i}` } },
			}),
		),
	);

	return { project, task };
}

test.describe('Dropdown panels flip to the side with room — mobile (390x844)', () => {
	test('the mention picker opens above the composer when it sits near the bottom', async ({
		page,
		freshWorkspace,
	}) => {
		const { project, task } = await createProjectWithTalkativeTask(page, freshWorkspace.token);

		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		const composer = page.getByPlaceholder('Add a comment...');
		await expect(composer).toBeVisible({ timeout: 20000 });

		const viewport = page.viewportSize();
		if (!viewport) throw new Error('no viewport size');

		await composer.click();
		await composer.pressSequentially('@cap');

		const picker = page.getByTestId('mention-picker');
		await expect(picker).toBeVisible({ timeout: 20000 });

		// The comment list above the composer is virtualized, and Virtuoso keeps
		// correcting the scroll position as it swaps estimated row heights for real
		// ones. Two separate boundingBox() calls can therefore straddle a
		// correction and disagree, so read every rect in one evaluate: the whole
		// snapshot is then internally consistent whatever the list does next.
		const snapshot = () =>
			page.evaluate(() => {
				const anchor = document.querySelector<HTMLElement>(
					'textarea[placeholder="Add a comment..."]',
				);
				const panel = document.querySelector<HTMLElement>('[data-testid="mention-picker"]');
				if (!anchor || !panel) return null;
				const a = anchor.getBoundingClientRect();
				const p = panel.getBoundingClientRect();
				return {
					gapBelow: window.innerHeight - a.bottom,
					placement: panel.getAttribute('data-placement'),
					anchorTop: a.top,
					panelTop: p.top,
					panelBottom: p.bottom,
					viewportHeight: window.innerHeight,
				};
			});

		// Park the composer hard against the bottom of the viewport — the position
		// the flip exists for — and wait for the picker to have resolved upward
		// from there. Scrolling with the picker already open also exercises the
		// hook's scroll-driven re-measure. The poll returns a label rather than a
		// boolean so a failure says which precondition never held.
		let settled: Awaited<ReturnType<typeof snapshot>> = null;
		await expect
			.poll(
				async () => {
					await page
						.locator('main')
						.first()
						.evaluate((el) => {
							el.scrollTo({ top: el.scrollHeight });
						});
					const s = await snapshot();
					if (!s) return 'composer-or-picker-missing';
					if (s.gapBelow < 0 || s.gapBelow >= PICKER_MAX_HEIGHT) {
						return `composer-not-near-bottom:${Math.round(s.gapBelow)}`;
					}
					settled = s;
					return s.placement ?? 'no-placement-attribute';
				},
				{ timeout: 30000 },
			)
			.toBe('top');

		if (!settled) throw new Error('no settled snapshot captured');
		const { anchorTop, panelTop, panelBottom, viewportHeight } = settled;
		// Entirely above the composer. The tolerance absorbs sub-pixel rounding
		// only — the regression this guards against put the whole panel (256px)
		// on the wrong side.
		expect(panelBottom).toBeLessThanOrEqual(anchorTop + 0.5);
		// And inside the viewport on both edges, which is the shrink-to-fit clamp.
		expect(panelTop).toBeGreaterThanOrEqual(-0.5);
		expect(panelBottom).toBeLessThanOrEqual(viewportHeight + 0.5);
	});

	test('a panel near the top opens downward, and clamps instead of overflowing a short viewport', async ({
		page,
		freshWorkspace,
	}) => {
		const projectRes = await createProjectAndClearPlanning(page, '', freshWorkspace.token, {
			name: uniqueName('Filter Placement'),
			description: 'Filter panel placement test.',
		});
		const project = ((await projectRes.json()) as { data: CreatedProject }).data;

		await page.goto(`/projects/${project.slug}/tasks`);
		await waitForPageLoad(page);

		const toggle = page.getByTestId('task-filter-toggle');
		await expect(toggle).toBeVisible({ timeout: 20000 });
		await toggle.click();

		const panel = page.getByTestId('task-filter-panel');
		await expect(panel).toBeVisible({ timeout: 20000 });
		// The filter bar is the first row of <main>, so there is room below it.
		await expect(panel).toHaveAttribute('data-placement', 'bottom');

		const viewport = page.viewportSize();
		if (!viewport) throw new Error('no viewport size');
		const barBox = await waitForStableBox(page.getByTestId('task-filter-bar'));
		const panelBox = await waitForStableBox(panel);

		expect(panelBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 0.5);
		expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(viewport.height + 0.5);

		// Shrink the viewport to less than the panel's natural height. Flipping
		// alone cannot save it here — only the height clamp can — so this is what
		// proves the panel shrinks rather than running off the screen.
		const shortHeight = 380;
		await page.setViewportSize({ width: 390, height: shortHeight });
		await expect(panel).toBeVisible();

		const clampedBox = await waitForStableBox(panel);
		expect(clampedBox.y).toBeGreaterThanOrEqual(-0.5);
		expect(clampedBox.y + clampedBox.height).toBeLessThanOrEqual(shortHeight + 0.5);
	});
});

// Criterion #1 (real CSS): a passive `@@slug` chip must not read as an active,
// delivered mention. Its muted colour lands only if it beats the prose link rule
// `[&_a:not([data-mention-passive])]:text-info-soft-fg` in markdown-prose.tsx —
// a pure cascade-specificity outcome. happy-dom's getComputedStyle does not
// resolve the cascade, so the component tests (markdown-prose-mentions.test.tsx)
// assert `className` strings and passed for months while the real UI rendered
// every passive mention in active-blue. Only a real browser can see this class
// of bug, so the styling contract lives here and nowhere else.
import { expect, test } from '@playwright/test';
import { authenticate, createProjectAndClearPlanning, getToken, waitForPageLoad } from './helpers';

test.describe('Passive mention styling', () => {
	test.describe.configure({ retries: 2 });

	test('a passive @@mention is muted and dotted, not an active-blue link', async ({ page }) => {
		await authenticate(page);
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const projRes = await createProjectAndClearPlanning(page, '', token, {
			name: 'Passive Mention Style',
			description: 'x',
		});
		const project = ((await projRes.json()) as { data: { id: string; slug: string } }).data;

		const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		const agents = (
			(await agentsRes.json()) as {
				data: Array<{ id: string; slug: string; title: string; human_name: string | null }>;
			}
		).data;

		const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
			headers,
			data: { project_id: project.id, title: 'Passive Mention Task', assignee_id: agents[0].id },
		});
		const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

		// One comment carrying all three link kinds, so every assertion below is
		// relative and no colour is hard-coded: a passive mention, a task reference
		// (MENTION_CLASSES, the active-blue control) and a plain markdown link
		// (coloured by PROSE_CLASSES alone). Deliberately no ACTIVE @mention — that
		// would fire a real wakeup and start a run mid-test.
		await page.request.post(`/api/projects/${project.slug}/tasks/${task.id}/comments`, {
			headers,
			data: {
				content_type: 'text',
				content: {
					text: `${task.identifier} review: APPROVED. Ready for @@${agents[0].slug} strategic review. See [the notes](https://example.com/notes).`,
				},
			},
		});

		await page.goto(`/projects/${project.slug}/tasks/${task.id}`);
		await waitForPageLoad(page);

		const passive = page.locator('[data-testid="agent-mention-link"][data-mention-passive="true"]');
		await expect(passive).toBeVisible({ timeout: 20_000 });
		// The `@@` is stripped, and the chip shows what the agent is *called* rather
		// than the handle the author typed - its name when it has one, else its role.
		await expect(passive).toHaveText(agents[0].human_name?.trim() || agents[0].title);

		const styles = await page.evaluate(() => {
			const pick = (sel: string) => {
				const el = document.querySelector(sel);
				if (!el) return null;
				const s = getComputedStyle(el);
				return { color: s.color, decorationStyle: s.textDecorationStyle };
			};
			return {
				passive: pick('[data-testid="agent-mention-link"][data-mention-passive="true"]'),
				taskRef: pick('[data-testid="task-mention-link"]'),
				plainLink: pick('a[href="https://example.com/notes"]'),
			};
		});

		expect(styles.passive).not.toBeNull();
		expect(styles.taskRef).not.toBeNull();
		expect(styles.plainLink).not.toBeNull();

		// The regression: before the fix the prose rule's descendant selector
		// (0,1,1) outranked the chip's own class (0,1,0) and these were equal.
		expect(styles.passive!.color).not.toBe(styles.taskRef!.color);

		// …and the narrowed rule still colours every link it should, so the
		// `:not()` did not simply switch the prose link colour off.
		expect(styles.taskRef!.color).toBe(styles.plainLink!.color);

		// The decoration is the signal that survives even if a future blanket rule
		// reaches the colour again.
		expect(styles.passive!.decorationStyle).toBe('dotted');
		expect(styles.taskRef!.decorationStyle).not.toBe('dotted');

		// Mobile: the same contract must hold at the small breakpoint.
		await page.setViewportSize({ width: 390, height: 800 });
		await expect(passive).toBeVisible();
		const mobile = await page.evaluate(() => {
			const el = document.querySelector(
				'[data-testid="agent-mention-link"][data-mention-passive="true"]',
			);
			if (!el) return null;
			const s = getComputedStyle(el);
			return { color: s.color, decorationStyle: s.textDecorationStyle };
		});
		expect(mobile).not.toBeNull();
		expect(mobile!.decorationStyle).toBe('dotted');
		expect(mobile!.color).toBe(styles.passive!.color);
	});
});

// Real Chromium (decision tree #1 + #2): the task list's ID column used to wrap
// "HM-279" onto two lines, and the fix is a layout one — the assertions read
// computed `white-space` and laid-out element heights, plus the truncation gate on
// the title tooltip compares scrollWidth against clientWidth. happy-dom reports
// zeros for all of it. The mobile leg (375px) is where the ID column is under the
// most width pressure, since Project/Priority/Assignee are `hidden md:table-cell`
// while ID/Title/Status always render.

import { expect, test } from './fixtures';
import {
	createProjectAndClearPlanning,
	expectSingleLine,
	uniqueName,
	waitForPageLoad,
} from './helpers';

type Page = import('@playwright/test').Page;

async function createTaskViaApi(
	page: Page,
	projectSlug: string,
	token: string,
	data: { project_id: string; title: string },
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

test.describe('Task list — ID never wraps, truncated titles get a tooltip', () => {
	test('the identifier stays on one line and a clipped title reveals the full ID + title on hover', async ({
		page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		await page.setViewportSize({ width: 1280, height: 720 });

		const proj = await createProjectAndClearPlanning(page, '', token, {
			name: uniqueName('Task Id Nowrap'),
			description: 'Task list ID wrapping spec.',
		});

		// Long enough to overflow the Title column at any viewport this spec uses, so
		// the truncation gate on the tooltip is genuinely exercised.
		const longTitle = uniqueName(
			`Rework the deployment pipeline so every release candidate is promoted through staging with a full regression sweep, an approval gate, and a signed changelog before it reaches production`,
		);
		const shortTitle = uniqueName('Short one');

		const longTask = await createTaskViaApi(page, proj.slug, token, {
			project_id: proj.id,
			title: longTitle,
		});
		const shortTask = await createTaskViaApi(page, proj.slug, token, {
			project_id: proj.id,
			title: shortTitle,
		});

		// A sub-task guards the other half of the Title cell's sizing: the depth
		// indent is padding on the same <td> that now carries `max-w-0 w-full`.
		const subTitle = uniqueName('Nested one');
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const subRes = await page.request.post(
			`/api/projects/${proj.slug}/tasks/${shortTask.id}/sub-tasks`,
			{ headers, data: { title: subTitle, assignee_slug: 'captain' } },
		);
		if (!subRes.ok()) throw new Error(`sub-task create failed — ${await subRes.text()}`);

		await page.goto(`/projects/${proj.slug}/tasks`);
		await waitForPageLoad(page);

		// Scope every locator to the task's own row — the list also carries Captain's
		// background planning work, and the sections render identical cells.
		const longRow = page.getByRole('row').filter({ hasText: longTitle });
		const shortRow = page.getByRole('row').filter({ hasText: shortTitle });
		await expect(longRow).toBeVisible({ timeout: 20_000 });
		await expect(shortRow).toBeVisible({ timeout: 20_000 });

		// --- The reported bug: "HM-279" split across two lines ---
		for (const row of [longRow, shortRow]) {
			const identifier = row.getByTestId('task-identifier');
			await expect(identifier).toBeVisible();
			await expectSingleLine(identifier);
		}
		// The whole identifier is present, so nowrap isn't hiding a clipped ID.
		await expect(longRow.getByTestId('task-identifier')).toHaveText(longTask.identifier);
		await expect(shortRow.getByTestId('task-identifier')).toHaveText(shortTask.identifier);

		// --- A clipped title is truncated visually only, and hover reveals it ---
		const longTitleText = longRow.getByText(longTitle, { exact: true });
		await expectSingleLine(longTitleText);
		// Truncation is CSS-only: the full title stays in the DOM.
		await expect(longTitleText).toHaveText(longTitle);
		const clipped = await longTitleText.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
		expect(clipped).toBe(true);

		await longTitleText.hover();
		// Scope to the role="tooltip" panel — Radix also renders a hidden aria
		// duplicate of the content that carries the same testId.
		const tooltip = page.getByRole('tooltip');
		await expect(tooltip).toBeVisible({ timeout: 20_000 });
		await expect(tooltip).toContainText(`${longTask.identifier.toUpperCase()}: ${longTitle}`);
		await expect(tooltip.getByTestId('task-mention-status-pill')).toBeVisible();

		// --- The depth indent still renders on the now `max-w-0` title cell ---
		const subRow = page.getByRole('row').filter({ hasText: subTitle });
		await expect(subRow).toBeVisible({ timeout: 20_000 });
		// Polled, and both edges read inside the same attempt: the sub-task row
		// arrives via a list refetch that re-flows the table, so measuring the two
		// rows in separate awaits could straddle layout passes and compare a
		// settled parent against a mid-reflow child. Retrying keeps the assertion's
		// teeth - a genuinely missing indent still never satisfies it.
		await expect
			.poll(
				async () => {
					const parentLeft = await shortRow
						.getByText(shortTitle, { exact: true })
						.evaluate((el) => el.getBoundingClientRect().left);
					const subLeft = await subRow
						.getByText(subTitle, { exact: true })
						.evaluate((el) => el.getBoundingClientRect().left);
					return subLeft - parentLeft;
				},
				{ timeout: 10_000 },
			)
			// pl-5 sm:pl-6 (20-24px) plus the ↳ marker and its gap.
			.toBeGreaterThan(20);

		// --- A title that fits gets no tooltip (the truncation gate) ---
		// Radix keeps hoverable tooltip content open across a grace area between the
		// trigger and the panel, so step the pointer to empty space well clear of
		// both rather than jumping it.
		await page.mouse.move(1270, 500, { steps: 10 });
		await expect(page.getByRole('tooltip')).toHaveCount(0);

		const shortTitleText = shortRow.getByText(shortTitle, { exact: true });
		expect(await shortTitleText.evaluate((el) => el.scrollWidth > el.clientWidth + 1)).toBe(false);
		await shortTitleText.hover();
		// Well past the 150ms Radix open delay that the positive case above just
		// proved fires — so a still-absent tooltip is the gate, not a slow open.
		await page.waitForTimeout(1000);
		await expect(page.getByRole('tooltip')).toHaveCount(0);

		// --- Mobile: the ID column is squeezed hardest here ---
		await page.mouse.move(1270, 500, { steps: 10 });
		await page.setViewportSize({ width: 375, height: 800 });
		await expect(longRow.getByTestId('task-identifier')).toBeVisible();
		await expectSingleLine(longRow.getByTestId('task-identifier'));
		await expect(longRow.getByTestId('task-identifier')).toHaveText(longTask.identifier);
		await expectSingleLine(shortRow.getByTestId('task-identifier'));
	});
});

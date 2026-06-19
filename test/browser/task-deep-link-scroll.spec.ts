// Deep-link scroll behaviour needs a real browser (testing decision tree points
// 1 & 3): it asserts on <main>'s real `scrollTop` and a comment's `boundingBox`
// after the hash-driven scroll, and fires a real wheel event to prove the
// auto-scroll yields to the user. happy-dom returns 0 for layout and can't
// synthesise a native wheel, so this can't be a component test.
//
// Regression coverage for the inbox deep-link bugs: the executor used to centre
// the comment (not land it at the top), re-yank the viewport for ~3s via a blind
// retry ladder (fighting the user's scroll), then strip the `#comment-…` hash —
// which made the shell scroll-reset bounce the reader to the very top.

import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

type Page = import('@playwright/test').Page;

async function seedTaskWithComments(page: Page, token: string, count: number) {
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const projRes = await createProjectAndClearPlanning(page, '', token, {
		name: uniqueName('Deep Link Scroll'),
		description: 'Deep-link scroll test.',
	});
	const project = (
		(await projRes.json()) as { data: { id: string; slug: string; team_slug: string } }
	).data;

	const agentsRes = await page.request.get(`/api/projects/${project.slug}/agents`, { headers });
	const agents = ((await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }).data;
	const assigneeId = (agents.find((a) => a.slug === 'captain') ?? agents[0]).id;

	const taskRes = await page.request.post(`/api/projects/${project.slug}/tasks`, {
		headers,
		data: { project_id: project.id, title: 'Deep-link scroll task', assignee_id: assigneeId },
	});
	const task = ((await taskRes.json()) as { data: { id: string; identifier: string } }).data;

	// Seed enough text comments that the thread overflows <main> and the target
	// sits well below the fold. Authored by the admin token (no agent wakeup);
	// any later agent comments append at the bottom and don't shift the target.
	const created: { public_id: string; index: number }[] = [];
	const BATCH = 10;
	for (let start = 0; start < count; start += BATCH) {
		const batch = Array.from({ length: Math.min(BATCH, count - start) }, (_, i) => start + i);
		const results = await Promise.all(
			batch.map((i) =>
				page.request.post(`/api/projects/${project.slug}/tasks/${task.id}/comments`, {
					headers,
					data: {
						content_type: 'text',
						content: { text: `seeded comment ${i}. ${'lorem ipsum '.repeat(8)}` },
					},
				}),
			),
		);
		for (const [k, res] of results.entries()) {
			const json = (await res.json()) as { data: { public_id: string } };
			created.push({ public_id: json.data.public_id, index: batch[k] });
		}
	}

	return { project, task, created };
}

/** Vertical offset of the target comment's top from <main>'s top, in px. */
async function targetTopWithinMain(page: Page, publicId: string): Promise<number | null> {
	return page.evaluate((id) => {
		const el = document.getElementById(`comment-${id}`);
		const main = document.querySelector('main');
		if (!el || !main) return null;
		return Math.round(el.getBoundingClientRect().top - main.getBoundingClientRect().top);
	}, publicId);
}

const mainScrollTop = (page: Page) =>
	page
		.locator('main')
		.first()
		.evaluate((el) => el.scrollTop);

test.describe('Inbox deep-link scroll', () => {
	test('lands the target comment at the top and never jumps back to the top of the task', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		test.setTimeout(60_000);
		// A tall viewport so "near the top" (≈80px) is unambiguously distinct from
		// the old centred landing (~clientHeight/2).
		await page.setViewportSize({ width: 1280, height: 900 });
		const { project, task, created } = await seedTaskWithComments(page, sharedWorkspace.token, 30);
		const target = created[15];

		await page.goto(
			`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}#comment-${target.public_id}`,
		);
		await waitForPageLoad(page);

		const anchored = page.locator(`#comment-${target.public_id}`);
		await expect(anchored).toBeVisible({ timeout: 20_000 });

		// The executor strips the hash once the scroll settles. Wait for that so we
		// read the final resting position, not a mid-scroll frame.
		await expect
			.poll(() => page.evaluate(() => window.location.hash), { timeout: 15_000 })
			.toBe('');

		// (symptom 3) Stripping the hash must NOT bounce <main> to the top. The
		// target is deep in the thread, so a correct landing keeps a large scrollTop.
		expect(await mainScrollTop(page)).toBeGreaterThan(200);

		// (symptom 1) The comment sits near the TOP of the viewport (≈80px headroom
		// from `scroll-mt-20`), not centred.
		const top = await targetTopWithinMain(page, target.public_id);
		expect(top).not.toBeNull();
		expect(top as number).toBeGreaterThanOrEqual(0);
		expect(top as number).toBeLessThan(200);
	});

	test('a user scroll during the deep-link is honoured, not fought', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		test.setTimeout(60_000);
		await page.setViewportSize({ width: 1280, height: 900 });
		const { project, task, created } = await seedTaskWithComments(page, sharedWorkspace.token, 30);
		const target = created[15];

		await page.goto(
			`/projects/${project.slug}/tasks/${task.identifier.toLowerCase()}#comment-${target.public_id}`,
		);
		await waitForPageLoad(page);
		await expect(page.locator(`#comment-${target.public_id}`)).toBeVisible({ timeout: 20_000 });

		// The user takes over scrolling right after the landing. Hover <main> so the
		// wheel targets the scroll container, then scroll away from the comment.
		const main = page.locator('main').first();
		await main.hover();
		await page.mouse.wheel(0, 300);
		await page.waitForTimeout(150);
		const afterUser = await mainScrollTop(page);

		// Wait past the old retry-ladder + hash-strip window (~3.05s). On the buggy
		// build this is where the viewport snapped back to the comment and/or was
		// reset to the top; the fix backs off the moment the wheel fires and stays
		// where the user left it. (The wait is intrinsic to the time-based bug, not
		// masking a race.)
		await page.waitForTimeout(3500);
		const settled = await mainScrollTop(page);
		expect(Math.abs(settled - afterUser)).toBeLessThan(80);
	});
});

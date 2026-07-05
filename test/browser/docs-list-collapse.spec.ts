// Collapsing the doc list is a real-CSS-layout assertion (testing decision
// tree, point 1): it animates the sidebar grid track to zero width and the
// document pane reflows to the freed space — boundingBox() positions and
// zero-size visibility that happy-dom can't compute. The mobile check is
// viewport-conditional (point 2): the toggle only exists at md and up.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

test('collapsing the doc list gives the document the full width, and the choice survives a reload', async ({
	page,
	lightWorkspace,
}) => {
	const { projectSlug, token } = lightWorkspace;
	// Desktop: clears md (doc list beside the content pane) and lg (full rail).
	await page.setViewportSize({ width: 1280, height: 800 });

	const res = await page.request.put(`/api/projects/${projectSlug}/docs/collapse.md`, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { content: '# Collapse target\n\nBody text for the collapse spec.' },
	});
	expect(res.ok()).toBe(true);

	await page.goto(`/projects/${projectSlug}/documents?file=collapse.md`);
	await waitForPageLoad(page);

	const title = page.getByRole('heading', { name: 'collapse.md' });
	await expect(title).toBeVisible({ timeout: 20000 });
	const newDocButton = page.getByRole('button', { name: /New document/ });
	await expect(newDocButton).toBeVisible();

	// The list pane collapses to a zero-width grid track, which Playwright
	// treats as hidden. (Its inner controls keep their own padding box even
	// when clipped, so assert on the pane, not the buttons inside it.)
	const listPane = page.getByTestId('doc-list-pane');
	const toggle = page.getByTestId('doc-list-toggle');
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');

	const before = await title.boundingBox();
	expect(before).not.toBeNull();

	// Collapse: the list track animates to zero and the document toolbar
	// shifts left into the freed space.
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(listPane).toBeHidden();
	await expect
		.poll(async () => (await title.boundingBox())?.x ?? Number.NaN, { timeout: 5000 })
		// 240px track + 24px gap freed; allow slack for the toggle icon swap.
		.toBeLessThan((before?.x ?? 0) - 200);

	// The choice is remembered across a reload.
	await page.reload();
	await waitForPageLoad(page);
	await expect(title).toBeVisible({ timeout: 20000 });
	await expect(toggle).toHaveAttribute('aria-expanded', 'false');
	await expect(listPane).toBeHidden();

	// Expand again: the list comes back where it was.
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(newDocButton).toBeVisible();
	await expect
		.poll(async () => (await title.boundingBox())?.x ?? Number.NaN, { timeout: 5000 })
		.toBeGreaterThan((before?.x ?? 0) - 10);
});

test('mobile keeps the existing single-pane flow: no collapse toggle, Back still works', async ({
	page,
	lightWorkspace,
}) => {
	const { projectSlug, token } = lightWorkspace;
	await page.setViewportSize({ width: 375, height: 800 });

	const res = await page.request.put(`/api/projects/${projectSlug}/docs/mobile.md`, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { content: '# Mobile doc\n\nMobile body.' },
	});
	expect(res.ok()).toBe(true);

	await page.goto(`/projects/${projectSlug}/documents?file=mobile.md`);
	await waitForPageLoad(page);

	await expect(page.getByRole('heading', { name: 'mobile.md' })).toBeVisible({ timeout: 20000 });
	// The doc fills the screen on mobile with the list already hidden, so the
	// desktop collapse control would be redundant — it must not render.
	await expect(page.getByTestId('doc-list-toggle')).toBeHidden();
	// The existing mobile escape hatch back to the list is untouched.
	await page.getByRole('button', { name: /Back/ }).click();
	await expect(page.getByRole('button', { name: /New document/ })).toBeVisible();
});

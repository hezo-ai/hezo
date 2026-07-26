// Decision-tree point 1: the bug this pins is pure layout. The team list is a flex
// item that is itself a scroll container, so its automatic minimum size is 0 and a
// bounded dialog used to squeeze it below its content instead of letting it scroll —
// the last cards were unreachable. Proving it is fixed needs real clientHeight /
// scrollHeight / boundingBox values, all of which happy-dom reports as 0.

import { expect, test } from './fixtures';
import { mockMarketplaceCatalog, openTeamCatalog, waitForPageLoad } from './helpers';

test('the team list scrolls to its last card inside the dialog', async ({ sharedPage: page }) => {
	// A catalog big enough to overflow any viewport, so the assertion is about the
	// layout rather than about how many teams the marketplace happens to ship.
	await mockMarketplaceCatalog(page, 24);
	await page.setViewportSize({ width: 1280, height: 600 });
	await page.goto('/home');
	await waitForPageLoad(page);
	await openTeamCatalog(page);

	const scroller = page.getByTestId('team-list-scroll');
	await expect(scroller).toBeVisible();

	// The list must actually overflow, or the rest of this test proves nothing.
	expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
	// …and it must not have been squeezed to a sliver: it owns the dialog's
	// remaining height rather than a fixed vh guess.
	expect(await scroller.evaluate((el) => el.clientHeight)).toBeGreaterThan(120);

	// Scroll to the end: the last card is fully inside the scroller's visible box.
	await scroller.evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	const lastCard = scroller.locator('[data-testid^="marketplace-team-card-"]').last();
	await expect(lastCard).toBeVisible();
	const cardBox = await lastCard.boundingBox();
	const scrollerBox = await scroller.boundingBox();
	if (!cardBox || !scrollerBox) throw new Error('missing layout boxes');
	expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(scrollerBox.y + scrollerBox.height + 1);

	// The fixed chrome stayed put while the list scrolled beneath it.
	await expect(page.getByTestId('team-search')).toBeVisible();
	await expect(page.getByTestId('all-teams-back')).toBeVisible();

	// The dialog itself never runs past the viewport.
	const dialogBottom = await page
		.getByRole('dialog')
		.evaluate((el) => el.getBoundingClientRect().bottom - window.innerHeight);
	expect(dialogBottom).toBeLessThanOrEqual(1);
});

test('the team list takes the dialog height available, not a fixed fraction of the viewport', async ({
	sharedPage: page,
}) => {
	// The regression this pins: the list used to be capped at `max-h-[46vh]`, so on a
	// tall window it stayed a stub with the rest of the dialog empty below it, and it
	// was the only shrinkable item so a bounded dialog squeezed it instead of
	// scrolling. It now owns whatever height the dialog has left.
	await mockMarketplaceCatalog(page, 24);
	await page.setViewportSize({ width: 1280, height: 1000 });
	await page.goto('/home');
	await waitForPageLoad(page);
	await openTeamCatalog(page);

	const scroller = page.getByTestId('team-list-scroll');
	await expect(scroller).toBeVisible();

	const listHeight = await scroller.evaluate((el) => el.clientHeight);
	// Comfortably past the old 46vh ceiling (460px at this viewport).
	expect(listHeight).toBeGreaterThan(0.46 * 1000 + 40);

	// And it really is "the rest of the dialog": everything below the list's bottom
	// edge is just the dialog's own padding.
	const dialogBox = await page.getByRole('dialog').boundingBox();
	const listBox = await scroller.boundingBox();
	if (!dialogBox || !listBox) throw new Error('missing layout boxes');
	expect(dialogBox.y + dialogBox.height - (listBox.y + listBox.height)).toBeLessThan(40);
});

test('the catalog has no create actions and a card opens the roster', async ({
	sharedPage: page,
}) => {
	await mockMarketplaceCatalog(page, 24);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/home');
	await waitForPageLoad(page);
	await openTeamCatalog(page);

	await expect(page.getByTestId('create-project-submit')).toHaveCount(0);
	await expect(page.getByTestId('plan-with-ceo-submit')).toHaveCount(0);

	await page.getByTestId('team-list-scroll').locator('button').first().click();
	await expect(page.getByTestId('team-detail')).toBeVisible();
	await expect(page.getByTestId('team-detail-select')).toBeVisible();
	await expect(page.getByTestId('create-project-submit')).toHaveCount(0);

	// The roster reads as aligned columns from `sm:` up.
	const header = page.getByTestId('team-detail-roster').locator('li').first();
	expect(await header.evaluate((el) => getComputedStyle(el).display)).toBe('grid');
	expect(
		await header.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
	).toBe(3);

	// Select team lands back on the entry step with the create actions restored.
	await page.getByTestId('team-detail-select').click();
	await expect(page.getByTestId('selected-team-card')).toBeVisible();
	await expect(page.getByTestId('create-project-submit')).toBeVisible();
});

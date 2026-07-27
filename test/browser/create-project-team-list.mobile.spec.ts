// Decision-tree points 1-2: the team list's cut-off is real scroll/layout
// (clientHeight vs scrollHeight, boundingBox against the visual viewport) and the
// roster is viewport-conditional — it stacks per role below `sm:` and lays out as
// aligned columns above it. happy-dom runs neither layout nor media queries.

import { expect, test } from './fixtures';
import { mockMarketplaceCatalog, openTeamCatalog, waitForPageLoad } from './helpers';

test('mobile: the team list scrolls to its last card and the dialog fits the viewport', async ({
	sharedPage: page,
}) => {
	await mockMarketplaceCatalog(page, 24);
	await page.goto('/home');
	await waitForPageLoad(page);
	await openTeamCatalog(page);

	const scroller = page.getByTestId('team-list-scroll');
	await expect(scroller).toBeVisible();
	expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
	expect(await scroller.evaluate((el) => el.clientHeight)).toBeGreaterThan(120);

	await scroller.evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	const lastCard = scroller.locator('[data-testid^="marketplace-team-card-"]').last();
	await expect(lastCard).toBeVisible();
	const cardBox = await lastCard.boundingBox();
	const viewport = page.viewportSize();
	if (!cardBox || !viewport) throw new Error('missing layout boxes');
	// The bug: the last card's bottom edge used to sit below the visual viewport
	// with no scroll that could bring it back.
	expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(viewport.height);

	await expect(page.getByTestId('team-search')).toBeVisible();
	await expect(page.getByTestId('all-teams-back')).toBeVisible();
});

test('mobile: the roster stacks per role and Select team stays reachable', async ({
	sharedPage: page,
}) => {
	await mockMarketplaceCatalog(page, 24);
	await page.goto('/home');
	await waitForPageLoad(page);
	await openTeamCatalog(page);

	await page.getByTestId('team-list-scroll').locator('button').first().click();
	const detail = page.getByTestId('team-detail');
	await expect(detail).toBeVisible();

	// One column per role at 390px, so a role's three fields stack instead of
	// forcing the columns a table would need.
	const roster = page.getByTestId('team-detail-roster');
	const row = roster.locator('[data-testid^="roster-row-"]').first();
	expect(
		await row.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
	).toBe(1);
	// And nothing scrolls sideways. Measured on the dialog itself, which is the
	// horizontal scroll container (`overflow-y-auto` computes overflow-x to auto);
	// `team-detail` is overflow:visible, so its scrollWidth means nothing here.
	expect(
		await page.getByRole('dialog').evaluate((el) => el.scrollWidth - el.clientWidth),
	).toBeLessThanOrEqual(1);

	// The confirm action is pinned below the scrolling roster, inside the viewport.
	const select = page.getByTestId('team-detail-select');
	await expect(select).toBeVisible();
	const selectBox = await select.boundingBox();
	const viewport = page.viewportSize();
	if (!selectBox || !viewport) throw new Error('missing layout boxes');
	expect(selectBox.y + selectBox.height).toBeLessThanOrEqual(viewport.height);

	await select.click();
	await expect(page.getByTestId('selected-team-card')).toBeVisible();
});

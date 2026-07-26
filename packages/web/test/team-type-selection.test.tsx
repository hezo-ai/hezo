import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// The picked team must be visibly and exclusively highlighted — a bold inverse ring
// (`ring-2`), not just a hairline border-color flip. happy-dom can't measure the
// rendered ring, but it can assert the highlight class plus the pressed/current state
// land on the chosen card and nowhere else, which is what makes the choice legible.
// (No layout/CSS dependency, so this is a component test, not Playwright.)
//
// Catalog cards now *open* a team rather than toggling it, so they carry
// `aria-current` rather than `aria-pressed`; the entry step's confirmed-team card is
// the one that still toggles, and keeps `aria-pressed`.
test('selecting a team visibly highlights only the chosen card', async () => {
	const { findByTestId, getByTestId, queryByTestId, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {},
	});

	const create = await findByTestId('home-welcome-create', undefined, { timeout: 15_000 });
	await user.click(create);

	// The team cards live behind "View all teams" — the entry step opens on the
	// suggestion prompt, not the full catalog.
	await user.click(await findByTestId('view-all-teams', undefined, { timeout: 15_000 }));

	const blankBtn = await findByTestId('team-type-card-Blank', undefined, { timeout: 15_000 });
	const appTeamBtn = await findByTestId('team-type-card-App Team');
	// The inner Card <div> carries the highlight classes.
	const blankCard = () => blankBtn.querySelector('div');
	const appTeamCard = () => appTeamBtn.querySelector('div');

	// Nothing is selected initially: no ring, not current, and never pressed (these
	// cards navigate rather than toggle).
	expect(blankBtn.getAttribute('aria-current')).toBeNull();
	expect(blankBtn.getAttribute('aria-pressed')).toBeNull();
	expect(blankCard()?.className).not.toContain('ring-2');
	expect(appTeamCard()?.className).not.toContain('ring-2');

	// Clicking a card opens its detail — it does not select on its own.
	await user.click(blankBtn);
	await findByTestId('team-detail');
	expect(queryByTestId('create-project-submit')).toBeNull();

	// "Select team" confirms it and returns to the entry step, where the confirmed
	// card is a pressed toggle carrying the ring.
	await user.click(getByTestId('team-detail-select'));
	const confirmed = await findByTestId('selected-team-card');
	const confirmedBtn = confirmed.querySelector('button[data-testid="team-type-card-Blank"]');
	expect(confirmedBtn?.getAttribute('aria-pressed')).toBe('true');
	expect(confirmedBtn?.querySelector('div')?.className).toContain('ring-2');
	expect(confirmedBtn?.querySelector('div')?.className).toContain('ring-inverse');

	// Back in the catalog the choice is still legible, and exclusive.
	await user.click(getByTestId('choose-different-team'));
	const blankAgain = await findByTestId('team-type-card-Blank');
	const appTeamAgain = await findByTestId('team-type-card-App Team');
	expect(blankAgain.getAttribute('aria-current')).toBe('true');
	expect(blankAgain.querySelector('div')?.className).toContain('ring-2');
	expect(blankAgain.querySelector('div')?.className).toContain('ring-inverse');
	expect(appTeamAgain.getAttribute('aria-current')).toBeNull();
	expect(appTeamAgain.querySelector('div')?.className).not.toContain('ring-2');

	// Switching teams moves the highlight off Blank.
	await user.click(appTeamAgain);
	await user.click(await findByTestId('team-detail-select'));
	await user.click(getByTestId('choose-different-team'));
	expect((await findByTestId('team-type-card-App Team')).getAttribute('aria-current')).toBe('true');
	expect((await findByTestId('team-type-card-Blank')).getAttribute('aria-current')).toBeNull();
});

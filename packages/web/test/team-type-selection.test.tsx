import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// The team-type / source-team cards in the New Project dialog must show a clearly
// visible highlight on the picked card — a bold inverse ring (`ring-2`), not just
// a hairline border-color flip. happy-dom can't measure the rendered ring, but it
// can assert the highlight class + `aria-pressed` land on the selected card and
// nowhere else, which is what makes the choice legible. (No layout/CSS dependency,
// so this is a component test, not Playwright.)
test('selecting a team type visibly highlights only the chosen card', async () => {
	const { findByTestId, user } = await renderApp({ initialPath: '/home', seed: async () => {} });

	const create = await findByTestId('home-welcome-create', undefined, { timeout: 15_000 });
	await user.click(create);

	const blankBtn = await findByTestId('team-type-card-Blank', undefined, { timeout: 15_000 });
	const appTeamBtn = await findByTestId('team-type-card-App Team');
	// The inner Card <div> carries the highlight classes.
	const blankCard = () => blankBtn.querySelector('div');
	const appTeamCard = () => appTeamBtn.querySelector('div');

	// Nothing is selected initially: no ring, not pressed.
	expect(blankBtn.getAttribute('aria-pressed')).toBe('false');
	expect(blankCard()?.className).not.toContain('ring-2');
	expect(appTeamCard()?.className).not.toContain('ring-2');

	// Pick Blank → it gets the visible ring + pressed state.
	await user.click(blankBtn);
	expect(blankBtn.getAttribute('aria-pressed')).toBe('true');
	expect(blankCard()?.className).toContain('ring-2');
	expect(blankCard()?.className).toContain('ring-inverse');
	// And the highlight is exclusive — App Team stays plain.
	expect(appTeamBtn.getAttribute('aria-pressed')).toBe('false');
	expect(appTeamCard()?.className).not.toContain('ring-2');

	// Switching to App Team moves the highlight off Blank.
	await user.click(appTeamBtn);
	expect(appTeamBtn.getAttribute('aria-pressed')).toBe('true');
	expect(appTeamCard()?.className).toContain('ring-2');
	expect(blankBtn.getAttribute('aria-pressed')).toBe('false');
	expect(blankCard()?.className).not.toContain('ring-2');
});

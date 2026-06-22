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
	const startupBtn = await findByTestId('team-type-card-Startup');
	// The inner Card <div> carries the highlight classes.
	const blankCard = () => blankBtn.querySelector('div');
	const startupCard = () => startupBtn.querySelector('div');

	// Nothing is selected initially: no ring, not pressed.
	expect(blankBtn.getAttribute('aria-pressed')).toBe('false');
	expect(blankCard()?.className).not.toContain('ring-2');
	expect(startupCard()?.className).not.toContain('ring-2');

	// Pick Blank → it gets the visible ring + pressed state.
	await user.click(blankBtn);
	expect(blankBtn.getAttribute('aria-pressed')).toBe('true');
	expect(blankCard()?.className).toContain('ring-2');
	expect(blankCard()?.className).toContain('ring-inverse');
	// And the highlight is exclusive — Startup stays plain.
	expect(startupBtn.getAttribute('aria-pressed')).toBe('false');
	expect(startupCard()?.className).not.toContain('ring-2');

	// Switching to Startup moves the highlight off Blank.
	await user.click(startupBtn);
	expect(startupBtn.getAttribute('aria-pressed')).toBe('true');
	expect(startupCard()?.className).toContain('ring-2');
	expect(blankBtn.getAttribute('aria-pressed')).toBe('false');
	expect(blankCard()?.className).not.toContain('ring-2');
});

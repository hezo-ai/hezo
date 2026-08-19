import { screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

/**
 * The New Project dialog's third screen: picking a team from the catalog opens that
 * team's detail (its roster) inside the dialog, and "Select team" is the only way to
 * commit from there. The browse screens carry no create actions.
 */
async function openCatalogFromHome(afterSeed?: (ws: SeededWorkspace) => Promise<void>) {
	let ws!: SeededWorkspace;
	const utils = await renderApp({
		initialPath: '/home',
		seed: async () => {
			ws = await seedWorkspace();
			await seedProject(ws, { name: 'Existing Project' });
			await afterSeed?.(ws);
			sessionStorage.setItem('hezo:activeTeamSlug', ws.team.slug);
		},
	});
	const section = await utils.findByTestId('home-projects', undefined, { timeout: 15_000 });
	await utils.user.click(within(section).getByTestId('home-new-project'));
	await utils.findByPlaceholderText('e.g. Marketing Site');
	await utils.user.click(
		await utils.findByTestId('view-all-teams', undefined, { timeout: 15_000 }),
	);
	await utils.findByTestId('team-search');
	return { ...utils, ws };
}

test('the catalog has no create actions, and a card opens the team detail', async () => {
	const { user, findByTestId } = await openCatalogFromHome();

	// The browse screen is for picking — the submit actions live on the entry step.
	expect(screen.queryByTestId('create-project-submit')).toBeNull();
	expect(screen.queryByTestId('plan-with-ceo-submit')).toBeNull();

	await user.click(await findByTestId('team-type-card-App Team', undefined, { timeout: 15_000 }));

	const detail = await findByTestId('team-detail');
	expect(within(detail).getByText('App Team')).toBeTruthy();
	await findByTestId('team-detail-roster');
	await findByTestId('team-detail-select');
	// Still no create actions on the detail screen.
	expect(screen.queryByTestId('create-project-submit')).toBeNull();
	expect(screen.queryByTestId('plan-with-ceo-submit')).toBeNull();
});

test('Select team confirms the choice and returns to the project fields', async () => {
	const { user, findByTestId } = await openCatalogFromHome();

	await user.click(await findByTestId('team-type-card-Blank', undefined, { timeout: 15_000 }));
	await user.click(await findByTestId('team-detail-select'));

	// Back on the entry step with the team shown and both actions available.
	const selected = await findByTestId('selected-team-card');
	expect(within(selected).getByText('Blank')).toBeTruthy();
	await findByTestId('create-project-submit');
	await findByTestId('plan-with-ceo-submit');
	// The project fields survived the round trip.
	await screen.findByPlaceholderText('e.g. Marketing Site');
});

test('Back to teams returns to the catalog without selecting', async () => {
	const { user, findByTestId } = await openCatalogFromHome();

	await user.click(await findByTestId('team-type-card-Blank', undefined, { timeout: 15_000 }));
	await findByTestId('team-detail');
	await user.click(await findByTestId('team-detail-back'));

	// The catalog is back and nothing was chosen.
	await findByTestId('team-search');
	await waitFor(() => expect(screen.queryByTestId('team-detail')).toBeNull());
	await user.click(await findByTestId('all-teams-back'));
	expect(screen.queryByTestId('selected-team-card')).toBeNull();
	expect(screen.queryByTestId('create-project-submit')).toBeNull();
});

test("the Blank template's detail shows a Captain-only roster", async () => {
	const { user, findByTestId } = await openCatalogFromHome();

	await user.click(await findByTestId('team-type-card-Blank', undefined, { timeout: 15_000 }));

	const roster = await findByTestId('team-detail-roster');
	// Exactly one role: the Captain every team is provisioned with.
	expect(roster.querySelectorAll('[data-testid^="roster-row-"]').length).toBe(1);
	await findByTestId('roster-row-captain');
	expect((await findByTestId('team-detail')).textContent).toContain('hire roles as you need them');
});

test("a marketplace team's detail renders its fetched roster", async () => {
	const { user, findByTestId } = await openCatalogFromHome();

	await user.click(
		await findByTestId('marketplace-team-card-app-dev', undefined, {
			timeout: 15_000,
		}),
	);

	// The catalog index carries no roster, so this proves the per-team fetch fired.
	await findByTestId('team-detail-roster');
	await findByTestId('roster-row-architect');
	await findByTestId('roster-row-engineer');
	// Reporting lines read as role titles, not raw slugs.
	expect((await findByTestId('roster-row-architect')).textContent).toContain('Captain');
});

test("an existing team's detail lists its live agents and hides the HQ CEO/Coach", async () => {
	const { user, findByTestId, ws } = await openCatalogFromHome();

	await user.click(await findByTestId('team-tab-copy', undefined, { timeout: 15_000 }));
	await user.click(await findByTestId(`source-team-card-${ws.team.slug}`));

	// The seeded team's real hired agents, led by its Captain.
	const roster = await findByTestId('team-detail-roster');
	const rows = [...roster.querySelectorAll('[data-testid^="roster-row-"]')];
	expect(rows.length).toBeGreaterThan(1);
	expect(rows[0].getAttribute('data-testid')).toBe('roster-row-captain');
	expect(rows.some((r) => r.getAttribute('data-testid') === 'roster-row-engineer')).toBe(true);

	// This team is provisioned from a `team_templates` row, and `agent_types` carries
	// no identity columns - so its agents have no human name and each row is its role
	// alone. (Names reach `member_agents` only via the marketplace provisioning path.)
	expect((await findByTestId('roster-row-engineer')).textContent).toContain('Engineer');

	// HQ's CEO and Coach are surfaced as virtual members of every project but are not
	// part of the roster a clone would copy, so they get no row.
	expect(screen.queryByTestId('roster-row-ceo')).toBeNull();
	expect(screen.queryByTestId('roster-row-coach')).toBeNull();
});

test("a named agent's roster row leads with the name and keeps the role beneath", async () => {
	const { user, findByTestId, ws } = await openCatalogFromHome(async (seeded) => {
		const engineer = seeded.agents.find((a) => a.slug === 'engineer');
		if (!engineer) throw new Error('seeded roster is missing the engineer');
		const { apiBase } = getTestContext();
		const res = await apiBase(`/api/projects/${seeded.internalSlug}/agents/${engineer.id}`, {
			method: 'PATCH',
			headers: seeded.headers,
			body: JSON.stringify({ human_name: 'Max' }),
		});
		expect(res.status).toBe(200);
	});

	await user.click(await findByTestId('team-tab-copy', undefined, { timeout: 15_000 }));
	await user.click(await findByTestId(`source-team-card-${ws.team.slug}`));

	// Named: "Max" leads and "Engineer" stays as the supporting line, so the roster
	// matches the name this agent is called by everywhere else in the UI.
	const engineer = await findByTestId('roster-row-engineer');
	expect(engineer.textContent).toContain('Max');
	expect(engineer.textContent).toContain('Engineer');

	// Naming an agent also composes its avatar, so the row shows the sprite.
	expect(engineer.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
});

test('mod+Enter does not create the project from the catalog or the detail', async () => {
	const { user, findByTestId, router } = await openCatalogFromHome();

	// Fill the fields and confirm a team, so the shortcut would otherwise be armed.
	await user.click(await findByTestId('team-type-card-Blank', undefined, { timeout: 15_000 }));
	await user.click(await findByTestId('team-detail-select'));
	await user.type(await screen.findByPlaceholderText('e.g. Marketing Site'), 'Shortcut Test');
	await user.type(
		screen.getByPlaceholderText(
			'What is this project? Domain, users, and the core problem it solves.',
		),
		'A project used to check the submit shortcut is scoped to the entry step.',
	);
	const submit = (await findByTestId('create-project-submit')) as HTMLButtonElement;
	await waitFor(() => expect(submit.disabled).toBe(false));

	// On the catalog: the create button is unmounted, so its binding is gone.
	await user.click(await findByTestId('choose-different-team'));
	await findByTestId('team-search');
	await user.keyboard('{Control>}{Enter}{/Control}');
	expect(router.state.location.pathname).toBe('/home');

	// Same on the detail screen.
	await user.click(await findByTestId('team-type-card-Blank'));
	await findByTestId('team-detail');
	await user.keyboard('{Control>}{Enter}{/Control}');
	expect(router.state.location.pathname).toBe('/home');
	await findByTestId('team-detail');
});

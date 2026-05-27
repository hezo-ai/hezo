import { test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

async function createBareTeam(): Promise<{ slug: string }> {
	const { apiBase, token } = getTestContext();
	const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
	const res = await apiBase('/api/teams', {
		method: 'POST',
		headers,
		body: JSON.stringify({ name: `Light Team ${Math.random().toString(36).slice(2, 8)}` }),
	});
	return ((await res.json()) as { data: { slug: string } }).data;
}

test('shows placeholder when no team summary is set', async () => {
	const seeded = { teamSlug: '' };
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const team = await createBareTeam();
			seeded.teamSlug = team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/agents',
		params: { teamId: seeded.teamSlug },
	});

	await findByText('Team description being generated…', undefined, { timeout: 10_000 });
});

test('renders the team-summary box with attribution caption', async () => {
	const seeded = { teamSlug: '' };
	const { findByText, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/agents',
		params: { teamId: seeded.teamSlug },
	});

	await findByTestId('team-summary', undefined, { timeout: 10_000 });
	await findByText("Auto-generated from the agents' system prompts.", undefined, {
		timeout: 10_000,
	});
});

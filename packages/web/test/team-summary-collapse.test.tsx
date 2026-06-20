import { createTestTeam } from '@hezo/server/test/helpers/app';
import { test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

async function createBareTeam(): Promise<{ slug: string }> {
	const { db } = getTestContext();
	const res = await createTestTeam(db, {
		name: `Light Team ${Math.random().toString(36).slice(2, 8)}`,
	});
	return ((await res.json()) as { data: { slug: string } }).data;
}

test('shows placeholder when no team summary is set', async () => {
	const seeded = { projectSlug: '' };
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const team = await createBareTeam();
			seeded.projectSlug = team.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents',
		params: { projectId: seeded.projectSlug },
	});

	await findByText('Team description being generated…', undefined, { timeout: 10_000 });
});

test('renders the team-summary box with attribution caption', async () => {
	const seeded = { projectSlug: '' };
	const { findByText, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.projectSlug = ws.internalSlug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents',
		params: { projectId: seeded.projectSlug },
	});

	await findByTestId('team-summary', undefined, { timeout: 10_000 });
	await findByText("Auto-generated from the agents' system prompts.", undefined, {
		timeout: 10_000,
	});
});

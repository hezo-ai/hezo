import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

// The team page renders the org chart. Two avatar paths must both work there:
// the HQ-singleton CEO shows its built-in shipped portrait, and every other
// agent shows the sprite generated from its own spec — nobody is left as
// initials, which was the "changed avatar but it's not showing" case.
test('org chart shows the shipped CEO portrait and a generated avatar for the Captain', async () => {
	let nav!: { projectSlug: string; captainTitle: string };
	const { container, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain');
			if (!captain) throw new Error('seed: captain missing');
			nav = { projectSlug: ws.internalSlug, captainTitle: captain.title };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents',
		params: { projectId: nav.projectSlug },
	});

	// Org chart rendered once the Captain node is on screen.
	await findByText(nav.captainTitle);

	// CEO (HQ singleton) keeps its shipped portrait.
	expect(container.querySelector('img[src="/avatars/ceo.png"]')).not.toBeNull();

	// The Captain has no shipped portrait, so it draws its generated sprite -
	// an inline SVG data URI rather than a fetched image.
	expect(container.querySelector('img[src^="data:image/svg+xml"]')).not.toBeNull();
});

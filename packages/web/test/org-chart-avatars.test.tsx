import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

// The team page renders the org chart. Two avatar paths must both work there:
// the HQ-singleton CEO shows its built-in default image (no upload needed), and
// any agent with an uploaded avatar shows it — the reported "changed avatar but
// it's not showing on the team page" case.
test('org chart shows the built-in CEO default and an uploaded agent avatar', async () => {
	let nav!: { projectSlug: string; captainId: string; captainTitle: string };
	const { container, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain');
			if (!captain) throw new Error('seed: captain missing');
			// The Captain is a per-project role (no built-in default) — give it an
			// uploaded avatar so we assert the upload renders on the org chart.
			await ctx.db.query(
				`INSERT INTO agent_icons (member_id, content_type, data, byte_size, width, height)
				 VALUES ($1, 'image/png', $2, 3, 512, 512)`,
				[captain.id, Buffer.from([0x89, 0x50, 0x4e])],
			);
			nav = {
				projectSlug: ws.internalSlug,
				captainId: captain.id,
				captainTitle: captain.title,
			};
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents',
		params: { projectId: nav.projectSlug },
	});

	// Org chart rendered once the Captain node is on screen.
	await findByText(nav.captainTitle);

	// CEO (HQ singleton) falls back to its shipped default avatar.
	expect(container.querySelector('img[src="/avatars/ceo.png"]')).not.toBeNull();

	// The Captain's uploaded avatar renders (no default for per-project roles).
	expect(container.querySelector(`img[src^="/api/agents/${nav.captainId}/icon"]`)).not.toBeNull();
});

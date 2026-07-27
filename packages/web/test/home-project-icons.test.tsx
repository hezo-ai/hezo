// An uploaded project icon has to follow the project everywhere its avatar is
// drawn, not just the left rail. The reported bug: you upload an icon on the
// project's Settings page, and the Home dashboard - the first screen after login
// - still shows the bare initials. These specs pin the icon onto both Home
// surfaces (the Active card and the Other-projects row) and onto the rail's
// pinned HQ entry, which used to hardcode a building glyph. Component tier.

import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

const PNG_STUB = Buffer.from([0x89, 0x50, 0x4e]);

async function giveProjectAnIcon(projectId: string): Promise<void> {
	await getTestContext().db.query(
		`INSERT INTO project_icons (project_id, content_type, data, byte_size, width, height)
		 VALUES ($1, 'image/png', $2, 3, 512, 512)`,
		[projectId, PNG_STUB],
	);
}

test('the Home active card renders the uploaded project icon instead of initials', async () => {
	const ref = { id: '', name: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Iconic Project' });
			ref.id = project.id;
			ref.name = project.name;
			// A running agent ranks the project into the Active section.
			await getTestContext().db.query(
				`UPDATE member_agents SET runtime_status = 'active'::agent_runtime_status WHERE id = $1`,
				[ws.agents[0].id],
			);
			await giveProjectAnIcon(project.id);
		},
	});

	await router.navigate({ to: '/home' });

	const card = await findByTestId('home-active-card', undefined, { timeout: 20_000 });
	const img = card.querySelector<HTMLImageElement>('img');
	expect(img).not.toBeNull();
	expect(img?.getAttribute('src') ?? '').toContain(`/api/projects/${ref.id}/icon`);
	// The initials fallback is replaced, not merely covered.
	expect(card.textContent).not.toContain('IP');
});

test('a project with no icon keeps its initials on the Home active card', async () => {
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			await seedProject(ws, { name: 'Plain Project' });
			await getTestContext().db.query(
				`UPDATE member_agents SET runtime_status = 'active'::agent_runtime_status WHERE id = $1`,
				[ws.agents[0].id],
			);
		},
	});

	await router.navigate({ to: '/home' });

	const card = await findByTestId('home-active-card', undefined, { timeout: 20_000 });
	expect(card.querySelector('img')).toBeNull();
	expect(card.textContent).toContain('PP');
});

test('the Home Other-projects row renders the uploaded project icon', async () => {
	const ref = { id: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Quiet Project' });
			ref.id = project.id;
			// No running agents and nothing pending → the project lands in "Other".
			await giveProjectAnIcon(project.id);
		},
	});

	await router.navigate({ to: '/home' });

	const row = await findByTestId('home-other-row', undefined, { timeout: 20_000 });
	const img = row.querySelector<HTMLImageElement>('img');
	expect(img).not.toBeNull();
	expect(img?.getAttribute('src') ?? '').toContain(`/api/projects/${ref.id}/icon`);
});

test('the project rail shows HQ’s uploaded icon in place of the building glyph', async () => {
	const ref = { hqId: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			await seedProject(ws, { name: 'Rail Project' });
			const hq = await getTestContext().db.query<{ id: string }>(
				`SELECT id FROM projects WHERE is_internal = true LIMIT 1`,
			);
			ref.hqId = hq.rows[0].id;
			await giveProjectAnIcon(ref.hqId);
		},
	});

	await router.navigate({ to: '/home' });

	const hqEntry = await findByTestId('project-rail-hq', undefined, { timeout: 20_000 });
	const img = hqEntry.querySelector<HTMLImageElement>('img');
	expect(img).not.toBeNull();
	expect(img?.getAttribute('src') ?? '').toContain(`/api/projects/${ref.hqId}/icon`);
});

test('the project rail falls back to the building glyph when HQ has no icon', async () => {
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			await seedProject(ws, { name: 'Glyph Project' });
		},
	});

	await router.navigate({ to: '/home' });

	const hqEntry = await findByTestId('project-rail-hq', undefined, { timeout: 20_000 });
	expect(hqEntry.querySelector('img')).toBeNull();
	expect(hqEntry.querySelector('svg')).not.toBeNull();
});

import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

// The /home page is the Mission-control dashboard: a date header and project
// cards split into Active / Other, with live running / tasks / $-today stats.
test('home shows the dashboard with an active project card carrying live stats', async () => {
	const ref = { name: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Mission Demo' });
			const agent = ws.agents[0];
			const db = getTestContext().db;
			// One running agent + $4.82 spent today → an Active card with live stats.
			await db.query(
				`UPDATE member_agents SET runtime_status = 'active'::agent_runtime_status WHERE id = $1`,
				[agent.id],
			);
			await db.query(
				`INSERT INTO cost_entries (member_id, project_id, amount_cents) VALUES ($1, $2, 482)`,
				[agent.id, project.id],
			);
			ref.name = project.name;
		},
	});

	await router.navigate({ to: '/home' });

	// Active section renders.
	const active = await findByTestId('home-active', undefined, { timeout: 15_000 });
	expect(active.textContent).toContain(ref.name);

	// The card carries the running indicator and the $-today figure.
	const card = await findByTestId('home-active-card');
	expect(card.textContent).toContain('running');
	expect(card.textContent).toContain('tasks');
	expect(card.textContent).toContain('$4.82 today');
});

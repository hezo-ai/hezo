import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

test('project Activity page exposes the Outbound traffic (egress) tab', async () => {
	const seeded = { projectSlug: '' };
	const { findByRole, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.projectSlug = ws.internalSlug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/audit-log',
		params: { projectId: seeded.projectSlug },
	});

	await findByRole('heading', { name: 'Activity' }, { timeout: 10_000 });

	// Switching to the egress tab swaps in its description and empty state.
	await user.click(await findByRole('button', { name: 'Outbound traffic' }));
	await findByText(/Every outbound HTTPS request/, undefined, { timeout: 10_000 });
	expect(await findByText(/No outbound traffic recorded yet/)).toBeTruthy();
});

test('instance Activity log links project names and shows "-" for instance rows', async () => {
	const seeded = { slug: '' };
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Linked Project' });
			seeded.slug = project.slug;
			const { db } = getTestContext();
			// A project-scoped audit row — its Project cell should link to the project.
			await db.query(
				`INSERT INTO audit_log (project_id, actor_type, action, entity_type, entity_id, details)
				 VALUES ($1, 'admin'::audit_actor_type, 'created', 'secret', NULL, '{"name":"PROJECTSCOPEDSECRET"}'::jsonb)`,
				[project.id],
			);
			// An instance-scoped audit row (no project) — its Project cell shows a plain "-".
			await db.query(
				`INSERT INTO audit_log (project_id, actor_type, action, entity_type, entity_id, details)
				 VALUES (NULL, 'admin'::audit_actor_type, 'created', 'secret', NULL, '{"name":"INSTANCEONLYSECRET"}'::jsonb)`,
			);
		},
	});

	await router.navigate({ to: '/settings/audit-log' });

	// The Project column (last cell) of a project-scoped row links to the project page.
	const projectRow = await findByText(/PROJECTSCOPEDSECRET/, undefined, { timeout: 20_000 });
	const projectCell = projectRow.closest('tr')?.querySelector('td:last-child');
	const projectLink = projectCell?.querySelector('a');
	expect(projectLink?.getAttribute('href')).toContain(`/projects/${seeded.slug}`);
	expect(projectLink?.textContent).toBe('Linked Project');

	// The Project column of an instance-scoped row is a plain "-" with no link.
	const instanceRow = await findByText(/INSTANCEONLYSECRET/);
	const instanceCell = instanceRow.closest('tr')?.querySelector('td:last-child');
	expect(instanceCell?.textContent).toBe('-');
	expect(instanceCell?.querySelector('a')).toBeNull();
}, 30_000);

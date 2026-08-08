import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

/**
 * A connector that was working and has stopped is the one connector state an
 * operator must not have to go looking for: the refresh failure was recorded on
 * a row whose status still read "Connected", so the only signal was a red string
 * on a page nobody visits until something has already gone wrong. These cover
 * the banner that surfaces it on every page of the project.
 */

async function seedConnector(
	projectId: string,
	name: string,
	{ broken }: { broken: boolean },
): Promise<void> {
	const { db } = getTestContext();
	const project = await db.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [
		projectId,
	]);
	// `activated_at` set + `auth_error` set is exactly what "was working, now
	// broken" means - there is no separate health column.
	await db.query(
		`INSERT INTO mcp_connections (name, kind, project_id, activated_at, auth_error)
		 VALUES ($1, 'saas'::mcp_connection_kind, $2, now(), $3)`,
		[
			name,
			project.rows[0].id,
			broken ? 'token refresh: token endpoint error: invalid_grant' : null,
		],
	);
}

test('banner names a single broken connector', async () => {
	let ws: { internalSlug: string };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const w = await seedWorkspace();
			await seedConnector(w.internalSlug, 'interactive-brokers', { broken: true });
			ws = w;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: ws!.internalSlug },
	});

	const message = await findByTestId('connector-health-banner-message');
	expect(message.textContent).toContain('interactive-brokers');
	expect(message.textContent).toContain('stopped working');
});

test('banner counts several broken connectors', async () => {
	let ws: { internalSlug: string };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const w = await seedWorkspace();
			await seedConnector(w.internalSlug, 'interactive-brokers', { broken: true });
			await seedConnector(w.internalSlug, 'higgsfield', { broken: true });
			ws = w;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: ws!.internalSlug },
	});

	const message = await findByTestId('connector-health-banner-message');
	expect(message.textContent).toContain('2');
});

test('no banner when every connector is healthy', async () => {
	let ws: { internalSlug: string };
	const { router, queryByTestId, findByTestId } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const w = await seedWorkspace();
			await seedConnector(w.internalSlug, 'linear', { broken: false });
			ws = w;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/connectors',
		params: { projectId: ws!.internalSlug },
	});

	// Anchor on the connectors list (which the banner renders above) so this
	// cannot pass merely because nothing has rendered yet.
	await findByTestId('connectors-list');
	expect(queryByTestId('connector-health-banner')).toBeNull();
});

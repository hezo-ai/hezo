import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

// Component-tier coverage for the admin git-state panel on the Git settings page.
// Per the test decision tree this needs no real layout engine or WebSocket, so it
// runs here rather than as a Playwright spec. The in-process backend has no
// container for the seeded project, so the panel resolves to the container-stopped
// state — enough to prove the toggle gating and the lazy fetch wiring.

async function seedRepo(projectId: string, identifier = 'acme/website'): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO repos (project_id, repo_identifier, host_type, setup_status)
		 VALUES ($1, $2, 'github'::repo_host_type, 'ready'::repo_setup_status)`,
		[projectId, identifier],
	);
}

test('superuser can expand a repo to inspect its git state', async () => {
	let slug = '';
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Website' });
			await seedRepo(project.id);
			slug = project.slug;
		},
	});
	await router.navigate({ to: '/projects/$projectId/git', params: { projectId: slug } });

	// The superuser-only disclosure is present; expanding it lazily loads git state.
	const toggle = await findByTestId('repo-git-toggle-website');
	await user.click(toggle);

	// No container is provisioned for the seeded project, so the panel reports the
	// stopped-container state rather than spinning forever.
	await findByTestId('repo-git-container-stopped-website');
});

test('a non-superuser does not see the git-state disclosure', async () => {
	// Report the caller as a non-superuser to the UI (via /api/me) while the DB user
	// stays superuser, so project access — and the repo row — still resolve.
	const appFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			input instanceof Request ? input.url : typeof input === 'string' ? input : input.toString();
		if (new URL(url, 'http://localhost').pathname === '/api/me') {
			return new Response(JSON.stringify({ data: { type: 'admin', is_superuser: false } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return appFetch(input, init);
	}) as typeof globalThis.fetch;

	let slug = '';
	const { findByText, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Website' });
			await seedRepo(project.id);
			slug = project.slug;
		},
	});
	await router.navigate({ to: '/projects/$projectId/git', params: { projectId: slug } });

	// The repo row renders (the section loaded)…
	await findByText('website');
	// …but the superuser-only git-state disclosure is absent.
	expect(queryByTestId('repo-git-toggle-website')).toBeNull();
});

// The two per-project container surfaces, after containers became global.
//
// A project no longer has "a" container - it holds as many as it has concurrent
// runs - so the page that showed one container's status, log and lifecycle
// buttons was describing whichever one `projects.container_id` happened to name.
// What is left here is what is genuinely per project (the caps its containers
// are provisioned with, the image, the ports, the one warning worth acting on)
// plus the banner, which now fires on errors alone. The list, the log and Remove
// live on the global page and are covered by containers-list.test.tsx.

import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

interface FakeProjectOpts {
	slug: string;
	container_status: string | null;
	container_id?: string | null;
	container_error?: string | null;
	failed_container_count?: number;
	docker_base_image?: string | null;
	dev_ports?: Array<{ host: number; container: number }>;
	has_stranded_commits?: boolean;
}

function fakeProject(teamId: string, o: FakeProjectOpts) {
	return {
		id: `00000000-0000-0000-0000-${Math.random().toString(16).slice(2, 14).padStart(12, '0')}`,
		slug: o.slug,
		name: o.slug,
		team_id: teamId,
		task_prefix: 'CT',
		description: '',
		docker_base_image: o.docker_base_image ?? null,
		container_id: o.container_id ?? null,
		container_status: o.container_status,
		container_error: o.container_error ?? null,
		failed_container_count: o.failed_container_count ?? 0,
		container_last_logs: null,
		has_stranded_commits: o.has_stranded_commits ?? false,
		dev_ports: o.dev_ports ?? [],
		repo_count: 0,
		open_task_count: 0,
		is_internal: false,
		memory_limit_gib: null,
		created_at: new Date().toISOString(),
	};
}

/**
 * Render a route for a fetch-mocked project in a given container state. Both the
 * single-project read (the container page) and the index (the banner) are served
 * from the same fixture, so the two surfaces cannot be told different stories.
 */
async function renderWithProject(
	build: (teamId: string) => ReturnType<typeof fakeProject>,
	to: '/projects/$projectId/container' | '/projects/$projectId/inbox',
) {
	let ws!: SeededWorkspace;
	const ref = { slug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = { ...build(ws.team.id), team_slug: ws.team.slug, team_name: 'Demo Team' };
			ref.slug = project.slug;
			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;
				const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
				if (method === 'GET' && new RegExp(`/api/projects/${project.slug}$`).test(url)) {
					return new Response(JSON.stringify({ data: project }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				if (method === 'GET' && /\/api\/projects$/.test(url)) {
					return new Response(JSON.stringify({ data: [project] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo, init);
			}) as typeof globalThis.fetch;
		},
	});
	await helpers.router.navigate({ to, params: { projectId: ref.slug } });
	return { ...helpers, ref };
}

test('the project container page is settings only and points at the global list', async () => {
	const r = await renderWithProject(
		(teamId) =>
			fakeProject(teamId, {
				slug: 'settings-only',
				container_status: 'running',
				container_id: 'cafef00dbabe',
				docker_base_image: 'hezo/agent-base:latest',
			}),
		'/projects/$projectId/container',
	);

	// The per-project caps stay: they shape every container this project gets.
	await r.findByText('Memory per container', undefined, { timeout: 20_000 });
	await r.findByText('Disk per container');
	await r.findByText('hezo/agent-base:latest');

	// The lifecycle controls and the log went with the one-container model - a
	// Restart that replaced a project's whole fleet stopped meaning anything.
	expect(r.queryByRole('button', { name: /Restart/ })).toBeNull();
	expect(r.queryByRole('button', { name: /^Stop$/ })).toBeNull();
	expect(r.queryByRole('button', { name: /^Start$/ })).toBeNull();

	// Somebody who came here for a container's state is told where it went.
	const pointer = await r.findByTestId('container-page-pointer');
	expect((pointer.querySelector('a') as HTMLAnchorElement).getAttribute('href')).toContain(
		'/settings/containers',
	);
});

test('dev ports render as localhost links to the mapped host port', async () => {
	const r = await renderWithProject(
		(teamId) =>
			fakeProject(teamId, {
				slug: 'ports-container',
				container_status: 'running',
				container_id: 'deadbeef0000',
				docker_base_image: 'hezo/agent-base:latest',
				dev_ports: [{ host: 5181, container: 3000 }],
			}),
		'/projects/$projectId/container',
	);

	await r.findByText('Dev Ports', undefined, { timeout: 20_000 });
	const link = await r.findByText('3000→5181');
	expect((link.closest('a') as HTMLAnchorElement).getAttribute('href')).toBe(
		'http://localhost:5181',
	);
});

test('committed work that reached no remote is flagged on the project page', async () => {
	const r = await renderWithProject(
		(teamId) =>
			fakeProject(teamId, {
				slug: 'stranded-commits',
				container_status: 'running',
				container_id: 'aaaabbbbcccc',
				docker_base_image: 'hezo/agent-base:latest',
				has_stranded_commits: true,
			}),
		'/projects/$projectId/container',
	);

	const warning = await r.findByTestId('stranded-commits-warning', undefined, { timeout: 20_000 });
	expect(warning.textContent).toContain('Committed work has not reached a remote');
});

test('the banner flags a failed container and links to the global containers page', async () => {
	const r = await renderWithProject(
		(teamId) =>
			fakeProject(teamId, {
				slug: 'failed-banner',
				// Derived from the pool, not from `container_status`: a project is not
				// bound to one container, and that column latches - the sync loop
				// writes `error` while nulling `container_id`, after which no remove
				// can name the container to clear it.
				container_status: 'stopped',
				failed_container_count: 1,
			}),
		'/projects/$projectId/inbox',
	);

	const banner = await r.findByTestId('container-status-banner', undefined, { timeout: 20_000 });
	const message = await r.findByTestId('container-status-banner-message');
	expect(message.textContent ?? '').toContain('failed-banner');

	// Rebuild is gone, so the banner leads to the page where the failed container
	// is addressed as itself and can be removed.
	expect(banner.getAttribute('href') ?? '').toContain('/settings/containers');
	expect(banner.querySelector('button')).toBeNull();
});

test('a stored error status alone raises no banner once no container is failed', async () => {
	// The bug this replaced: `container_status = 'error'` is latched, cleared by
	// no remove or teardown path, and gates nothing - `acquireRunContainer` never
	// reads it and the pool skips failed members, so the next run simply creates a
	// fresh container. An operator who removed the failed container was left with
	// a permanent banner pointing at a page with nothing on it.
	const r = await renderWithProject(
		(teamId) =>
			fakeProject(teamId, {
				slug: 'stale-error',
				container_status: 'error',
				container_error: 'a failure that has since been cleared up',
				failed_container_count: 0,
			}),
		'/projects/$projectId/inbox',
	);

	// The project has loaded, so the absent banner is a decision rather than a
	// slow fetch.
	await r.findByTestId('project-sidebar-dashboard', undefined, { timeout: 20_000 });
	await waitFor(() => expect(r.queryByTestId('container-status-banner')).toBeNull());
	expect(r.queryByTestId('project-sidebar-container-error')).toBeNull();
});

test('a container being provisioned raises no banner', async () => {
	// The state this used to announce is now the ordinary one: a project gets a
	// container whenever a run needs one, so a banner for it would fire on almost
	// every page several times an hour, about something the operator did not ask
	// for and cannot act on.
	const r = await renderWithProject(
		(teamId) =>
			fakeProject(teamId, {
				slug: 'provisioning-banner',
				container_status: 'creating',
				docker_base_image: 'hezo/agent-base:latest',
			}),
		'/projects/$projectId/inbox',
	);

	// The project has loaded (its menu is named from the same index payload), so
	// the absent banner is a decision rather than a slow fetch.
	await r.findByTestId('project-sidebar-dashboard', undefined, { timeout: 20_000 });
	await waitFor(() => expect(r.queryByTestId('container-status-banner')).toBeNull());
	expect(r.queryByTestId('container-status-banner-provisioning')).toBeNull();
});

test('the project menu keeps an error marker but no provisioning spinner', async () => {
	const r = await renderWithProject(
		(teamId) =>
			fakeProject(teamId, {
				slug: 'sidebar-error',
				container_status: 'stopped',
				failed_container_count: 1,
			}),
		// The Containers row lives under Settings, which discloses only once that
		// subtree is the active route.
		'/projects/$projectId/container',
	);

	const row = await r.findByTestId('project-sidebar-container', undefined, { timeout: 20_000 });
	await r.findByTestId('project-sidebar-container-error');
	// Provisioning no longer marks the row at all, so the only marker it can carry
	// is the one that does not resolve on its own.
	expect(row.querySelector('.animate-spin')).toBeNull();
});

test('a real project reaches its container page through the menu', async () => {
	// One pass over the un-mocked path, so the fixtures above cannot drift from
	// what the API actually returns.
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Container Project' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/container',
		params: { projectId: projectSlug },
	});

	await findByText('Memory per container', undefined, { timeout: 20_000 });
});

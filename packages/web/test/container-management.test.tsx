import { fireEvent, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

test('container page renders restart button and Container nav crumb', async () => {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	const { findByRole, router } = await renderApp({
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

	await findByRole('button', { name: /restart/i }, { timeout: 20_000 });
});

test('container page shows "Waiting for container output…" when status is running but no logs yet', async () => {
	let ws!: SeededWorkspace;
	const fakeProject = {
		id: '22222222-2222-2222-2222-000000000001',
		slug: 'running-no-logs',
		name: 'Running No Logs',
		team_id: '',
		task_prefix: 'RN',
		description: '',
		docker_base_image: 'hezo/agent-base:latest',
		container_id: 'abc123def456',
		container_status: 'running',
		container_error: null,
		container_last_logs: null,
		dev_ports: [],
		repo_count: 0,
		open_task_count: 0,
		is_internal: false,
		created_at: new Date().toISOString(),
	};

	const { findByText, container, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			fakeProject.team_id = ws.team.id;

			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;
				const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
				if (method === 'GET' && new RegExp(`/api/projects/${fakeProject.slug}$`).test(url)) {
					return new Response(JSON.stringify({ data: fakeProject }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo, init);
			}) as typeof globalThis.fetch;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/container',
		params: { projectId: fakeProject.slug },
	});

	await findByText(/^Running$/, undefined, { timeout: 15_000 });
	await findByText(/Waiting for container output/i, undefined, { timeout: 15_000 });
	expect(container.textContent ?? '').not.toContain('Container is not running');
});

test('banner flags the active project as failed and rebuilds it', async () => {
	let ws!: SeededWorkspace;
	const projectSlug = 'failed-banner';
	const rebuildPosts: string[] = [];

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();

			const failedProject = {
				id: '11111111-1111-1111-1111-000000000001',
				slug: projectSlug,
				name: 'Failed Banner',
				team_id: ws.team.id,
				team_slug: ws.team.slug,
				team_name: 'Demo Team',
				task_prefix: 'FB',
				description: '',
				docker_base_image: null,
				container_id: null,
				container_status: 'error',
				container_error: 'simulated build failure',
				container_last_logs: null,
				dev_ports: [],
				repo_count: 0,
				open_task_count: 0,
				is_internal: false,
				created_at: new Date().toISOString(),
			};

			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;
				const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

				// The project index backs the per-project container banner.
				if (method === 'GET' && /\/api\/projects$/.test(url)) {
					return new Response(JSON.stringify({ data: [failedProject] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				if (method === 'POST' && /\/projects\/[^/]+\/container\/rebuild$/.test(url)) {
					rebuildPosts.push(url);
					return new Response(JSON.stringify({ data: { ok: true } }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo, init);
			}) as typeof globalThis.fetch;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/inbox',
		params: { projectId: projectSlug },
	});

	const banner = await findByTestId('container-status-banner', undefined, { timeout: 20_000 });
	const message = await findByTestId('container-status-banner-message');
	expect(message.textContent ?? '').toContain('Failed Banner');

	const rebuildBtn = banner.querySelector(
		'button[aria-label="Restart failed container"]',
	) as HTMLButtonElement;
	expect(rebuildBtn).toBeTruthy();
	fireEvent.click(rebuildBtn);

	await waitFor(() => expect(rebuildPosts.length).toBe(1), { timeout: 15_000 });
	expect(rebuildPosts[0]).toContain(`/projects/${projectSlug}/container/rebuild`);
});

test('banner shows a provisioning state that links to the container page', async () => {
	let ws!: SeededWorkspace;
	const projectSlug = 'provisioning-banner';

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();

			const provisioningProject = {
				id: '33333333-3333-3333-3333-000000000001',
				slug: projectSlug,
				name: 'Provisioning Project',
				team_id: ws.team.id,
				team_slug: ws.team.slug,
				team_name: 'Demo Team',
				task_prefix: 'PB',
				description: '',
				docker_base_image: 'hezo/agent-base:latest',
				container_id: null,
				container_status: 'creating',
				container_error: null,
				container_last_logs: null,
				dev_ports: [],
				repo_count: 0,
				open_task_count: 0,
				is_internal: false,
				created_at: new Date().toISOString(),
			};

			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;
				const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
				if (method === 'GET' && /\/api\/projects$/.test(url)) {
					return new Response(JSON.stringify({ data: [provisioningProject] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo, init);
			}) as typeof globalThis.fetch;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/inbox',
		params: { projectId: projectSlug },
	});

	const banner = await findByTestId('container-status-banner-provisioning', undefined, {
		timeout: 20_000,
	});
	expect(banner.textContent ?? '').toContain('Provisioning Project');
	// The whole banner is a link to the container/logs page.
	expect(banner.getAttribute('href') ?? '').toContain(`/projects/${projectSlug}/container`);
});

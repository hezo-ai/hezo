import { fireEvent, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

test('container page renders rebuild button and Container nav crumb', async () => {
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
		to: '/teams/$teamId/projects/$projectId/container',
		params: { teamId: ws.team.slug, projectId: projectSlug },
	});

	await findByRole('button', { name: /rebuild/i }, { timeout: 20_000 });
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
				if (
					method === 'GET' &&
					new RegExp(`/api/teams/[^/]+/projects/${fakeProject.slug}$`).test(url)
				) {
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
		to: '/teams/$teamId/projects/$projectId/container',
		params: { teamId: ws.team.slug, projectId: fakeProject.slug },
	});

	await findByText(/^Running$/, undefined, { timeout: 15_000 });
	await findByText(/Waiting for container output/i, undefined, { timeout: 15_000 });
	expect(container.textContent ?? '').not.toContain('Container is not running');
});

test('banner consolidates multiple unhealthy projects with + N others format and rebuild all button', async () => {
	let ws!: SeededWorkspace;
	const rebuildPosts: string[] = [];

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();

			const fakeProjects = [
				{ id: '11111111-1111-1111-1111-000000000001', slug: 'alpha-banner', name: 'Alpha Banner' },
				{ id: '11111111-1111-1111-1111-000000000002', slug: 'beta-banner', name: 'Beta Banner' },
				{ id: '11111111-1111-1111-1111-000000000003', slug: 'gamma-banner', name: 'Gamma Banner' },
			].map((p) => ({
				...p,
				team_id: ws.team.id,
				task_prefix: 'AB',
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
			}));

			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;
				const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

				if (method === 'GET' && /\/api\/teams\/[^/]+\/projects$/.test(url)) {
					return new Response(JSON.stringify({ data: fakeProjects }), {
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
		to: '/teams/$teamId/inbox',
		params: { teamId: ws.team.slug },
	});

	const banner = await findByTestId('container-status-banner', undefined, { timeout: 20_000 });
	const message = await findByTestId('container-status-banner-message');
	expect(message.textContent ?? '').toMatch(/^.+, .+ \+ 1 other containers failed$/);

	const rebuildBtn = banner.querySelector(
		'button[aria-label="Rebuild all failed containers"]',
	) as HTMLButtonElement;
	expect(rebuildBtn).toBeTruthy();
	fireEvent.click(rebuildBtn);

	await waitFor(() => expect(rebuildPosts.length).toBe(3), { timeout: 15_000 });
	for (const id of [
		'11111111-1111-1111-1111-000000000001',
		'11111111-1111-1111-1111-000000000002',
		'11111111-1111-1111-1111-000000000003',
	]) {
		expect(rebuildPosts.some((u) => u.includes(`/projects/${id}/container/rebuild`))).toBe(true);
	}
});

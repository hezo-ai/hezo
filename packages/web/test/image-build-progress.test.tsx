import { expect, test, vi } from 'vitest';

// The build state arrives over a WebSocket the component harness stubs to a
// no-op, so drive `useImageBuild` directly. A hoisted holder lets each test
// set the building snapshot the mocked hook returns.
const buildState = vi.hoisted(() => ({
	current: null as null | {
		status: string;
		building: boolean;
		percent: number;
		step: number | null;
		totalSteps: number | null;
		label: string | null;
	},
}));

vi.mock('@hezo/web/hooks/use-image-build', () => ({
	useImageBuild: () => buildState.current,
}));

import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

test('container page surfaces a Building image status and progress bar, overriding a stale Running', async () => {
	buildState.current = {
		status: 'building',
		building: true,
		percent: 42,
		step: 3,
		totalSteps: 7,
		label: 'RUN bun install',
	};

	let ws!: SeededWorkspace;
	const fakeProject = {
		id: '44444444-4444-4444-4444-000000000001',
		slug: 'building-image',
		name: 'Building Image',
		team_id: '',
		task_prefix: 'BI',
		description: '',
		docker_base_image: 'hezo/agent-base:latest',
		container_id: 'abc123def456',
		// Deliberately stale: the shared base image is rebuilding underneath a
		// container the DB still reports as running.
		container_status: 'running',
		container_error: null,
		container_last_logs: null,
		dev_ports: [],
		repo_count: 0,
		open_task_count: 0,
		is_internal: false,
		created_at: new Date().toISOString(),
	};

	const { findByTestId, getByRole, container, router } = await renderApp({
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

	await findByTestId('container-status-badge-building', undefined, { timeout: 15_000 });
	const card = await findByTestId('image-build-progress', undefined, { timeout: 15_000 });
	const bar = getByRole('progressbar');
	expect(bar.getAttribute('aria-valuenow')).toBe('42');
	expect(card.textContent ?? '').toContain('Step 3/7');
	expect(card.textContent ?? '').toContain('RUN bun install');
	// The build status wins over the stale "running" container_status.
	expect(container.textContent ?? '').toContain('Rebuilding');
	// The build progress also streams into the container log panel.
	expect(container.textContent ?? '').toContain('→ Step 3/7 RUN bun install');
});

test('project pages show a base-image build progress bar in the banner while provisioning', async () => {
	buildState.current = {
		status: 'building',
		building: true,
		percent: 67,
		step: 5,
		totalSteps: 7,
		label: 'RUN x',
	};

	let ws!: SeededWorkspace;
	const projectSlug = 'building-banner';

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const provisioningProject = {
				id: '55555555-5555-5555-5555-000000000001',
				slug: projectSlug,
				name: 'Building Banner',
				team_id: ws.team.id,
				team_slug: ws.team.slug,
				team_name: 'Demo Team',
				task_prefix: 'BB',
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

	const banner = await findByTestId('container-status-banner-building', undefined, {
		timeout: 20_000,
	});
	expect(banner.textContent ?? '').toContain('Rebuilding');
	expect(banner.textContent ?? '').toContain('Building Banner');
	expect(banner.textContent ?? '').toContain('67%');
	expect(banner.getAttribute('href') ?? '').toContain(`/projects/${projectSlug}/container`);
	expect(banner.querySelector('[role="progressbar"]')).toBeTruthy();
});

// Coverage for routes/projects/$projectId/container.tsx states the existing
// container-management spec doesn't reach: the error banner + dev-ports list, the
// stop / restart confirm-dialog action paths, and the LogViewer empty-state copy
// for the stopping / stopped / no-container phases. The project endpoint is
// fetch-mocked per state (matching the existing container spec). Component tier —
// the log scroll/virtualization that genuinely needs a browser is out of scope
// here (decision-tree items 1 & 5); this covers the render branches the tier can.

import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

interface FakeProjectOpts {
	slug: string;
	container_status: string;
	container_id?: string | null;
	container_error?: string | null;
	container_last_logs?: string | null;
	docker_base_image?: string | null;
	dev_ports?: Array<{ host: number; container: number }>;
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
		container_last_logs: o.container_last_logs ?? null,
		dev_ports: o.dev_ports ?? [],
		repo_count: 0,
		open_task_count: 0,
		is_internal: false,
		max_concurrent_runs: 1,
		memory_limit_gib: 16,
		created_at: new Date().toISOString(),
	};
}

/** Render the container page for a fetch-mocked project in a given state. */
async function renderContainer(
	build: (teamId: string) => ReturnType<typeof fakeProject>,
	opts?: { onStop?: () => void; onRebuild?: () => void },
) {
	let ws!: SeededWorkspace;
	const ref = { slug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = build(ws.team.id);
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
				if (method === 'POST' && /\/projects\/[^/]+\/container\/stop$/.test(url)) {
					opts?.onStop?.();
					return new Response(JSON.stringify({ data: { ok: true } }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				if (method === 'POST' && /\/projects\/[^/]+\/container\/rebuild$/.test(url)) {
					opts?.onRebuild?.();
					return new Response(JSON.stringify({ data: { ok: true } }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo, init);
			}) as typeof globalThis.fetch;
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/container',
		params: { projectId: ref.slug },
	});
	return { ...helpers, ref };
}

test('an errored container shows the error banner and the captured error text', async () => {
	const r = await renderContainer((teamId) =>
		fakeProject(teamId, {
			slug: 'errored-container',
			container_status: 'error',
			container_id: 'cafef00dbabe',
			container_error: 'pull access denied for hezo/agent-base',
		}),
	);

	// The status badge reads Error and the error banner surfaces the message.
	await r.findByText('Error', undefined, { timeout: 20_000 });
	await r.findByText('Container error');
	await r.findByText(/pull access denied for hezo\/agent-base/);
});

test('dev ports render as localhost links to the mapped host port', async () => {
	const r = await renderContainer((teamId) =>
		fakeProject(teamId, {
			slug: 'ports-container',
			container_status: 'running',
			container_id: 'deadbeef0000',
			docker_base_image: 'hezo/agent-base:latest',
			dev_ports: [{ host: 5181, container: 3000 }],
		}),
	);

	await r.findByText('Dev Ports', undefined, { timeout: 20_000 });
	const link = await r.findByText('3000→5181');
	expect((link.closest('a') as HTMLAnchorElement).getAttribute('href')).toBe(
		'http://localhost:5181',
	);
});

test('stopped container with no logs shows the "not running and no logs were captured" empty state', async () => {
	const r = await renderContainer((teamId) =>
		fakeProject(teamId, {
			slug: 'stopped-container',
			container_status: 'stopped',
			container_id: 'abcabcabcabc',
			docker_base_image: 'hezo/agent-base:latest',
			container_last_logs: null,
		}),
	);

	await r.findByText('Stopped', undefined, { timeout: 20_000 });
	await r.findByText('Container is not running and no logs were captured.');
});

test('a never-provisioned container (no container_id) shows the "No container provisioned" empty state and the No-container badge', async () => {
	const r = await renderContainer((teamId) =>
		fakeProject(teamId, {
			slug: 'no-container',
			container_status: null as unknown as string,
			container_id: null,
			docker_base_image: null,
		}),
	);

	await r.findByText('No container', undefined, { timeout: 20_000 });
	await r.findByText('No container provisioned.');
});

test('a stopped container with a captured snapshot log shows the "Last known logs" badge', async () => {
	const r = await renderContainer((teamId) =>
		fakeProject(teamId, {
			slug: 'snapshot-container',
			container_status: 'stopped',
			container_id: 'feedfacefeed',
			docker_base_image: 'hezo/agent-base:latest',
			container_last_logs: 'line one\nline two\nline three',
		}),
	);

	await r.findByText('Last known logs', undefined, { timeout: 20_000 });
	// The snapshot lines are split and rendered.
	await r.findByText('line two');
});

test('the Stop control opens a confirm dialog whose confirm posts to the stop endpoint', async () => {
	let stopped = false;
	const r = await renderContainer(
		(teamId) =>
			fakeProject(teamId, {
				slug: 'stop-flow',
				container_status: 'running',
				container_id: 'aaaabbbbcccc',
				docker_base_image: 'hezo/agent-base:latest',
			}),
		{ onStop: () => (stopped = true) },
	);

	// Stop is enabled while running.
	const stopBtn = await r.findByRole('button', { name: /Stop/ }, { timeout: 20_000 });
	await r.user.click(stopBtn);

	// ConfirmDialog renders into a portal on document.body.
	await r.findByText('Stop this container?');
	await r.user.click(await r.findByRole('button', { name: 'Stop' }));
	await waitFor(() => expect(stopped).toBe(true), { timeout: 15_000 });
});

test('the Restart control opens a confirm dialog whose confirm posts to the rebuild endpoint', async () => {
	let rebuilt = false;
	const r = await renderContainer(
		(teamId) =>
			fakeProject(teamId, {
				slug: 'restart-flow',
				container_status: 'running',
				container_id: 'ddddeeeeffff',
				docker_base_image: 'hezo/agent-base:latest',
			}),
		{ onRebuild: () => (rebuilt = true) },
	);

	const restartBtn = await r.findByRole('button', { name: /Restart/ }, { timeout: 20_000 });
	await r.user.click(restartBtn);

	await r.findByText('Restart container?');
	await r.user.click(await r.findByRole('button', { name: 'Restart' }));
	await waitFor(() => expect(rebuilt).toBe(true), { timeout: 15_000 });
});

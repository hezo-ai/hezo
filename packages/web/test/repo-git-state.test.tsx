import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

// Component-tier coverage for the admin git-state panel on the Git settings page.
// Per the test decision tree this needs no real layout engine or WebSocket, so it
// runs here rather than as a Playwright spec. The in-process backend has no
// container for the seeded project, so the panel resolves to its no-container
// state — enough to prove the toggle gating, the lazy fetch wiring, and what
// Refresh does from there.

async function seedRepo(projectId: string, identifier = 'acme/website'): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO repos (project_id, repo_identifier, host_type, setup_status)
		 VALUES ($1, $2, 'github'::repo_host_type, 'ready'::repo_setup_status)`,
		[projectId, identifier],
	);
}

const RUNNING_CLONE = {
	cloned: true,
	defaultBranch: 'main',
	headBranch: 'main',
	head: 'abcdef1234567',
	dirty: false,
	ahead: 0,
	behind: 0,
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * Stub both git-state routes: the `GET` the panel reads, and the `POST` Refresh
 * uses to ask for a container. The in-process backend has no container for the
 * seeded project, so a spec states the server's answers here instead. Returns a
 * restore fn so the global fetch never leaks into other tests.
 */
function stubGitState(payload: Record<string, unknown>, post?: () => Response): () => void {
	const appFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			input instanceof Request ? input.url : typeof input === 'string' ? input : input.toString();
		if (new URL(url, 'http://localhost').pathname.endsWith('/git-state')) {
			if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
				return (
					post?.() ??
					new Response(JSON.stringify({ data: { starting: true, container_running: false } }), {
						status: 200,
						headers: JSON_HEADERS,
					})
				);
			}
			return new Response(JSON.stringify({ data: payload }), {
				status: 200,
				headers: JSON_HEADERS,
			});
		}
		return appFetch(input, init);
	}) as typeof globalThis.fetch;
	return () => {
		globalThis.fetch = appFetch;
	};
}

async function renderExpandedPanel() {
	let slug = '';
	const rendered = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Website' });
			await seedRepo(project.id);
			slug = project.slug;
		},
	});
	await rendered.router.navigate({ to: '/projects/$projectId/git', params: { projectId: slug } });
	await rendered.user.click(await rendered.findByTestId('repo-git-toggle-website'));
	return rendered;
}

const RESET_ACTIONS = ['discard_local', 'prune_worktrees', 'reclone'] as const;

test('reset actions are disabled while a run is active on the project', async () => {
	const restore = stubGitState({
		container_running: true,
		clone: RUNNING_CLONE,
		worktrees: [],
		active_runs: 1,
	});
	try {
		const { findByTestId } = await renderExpandedPanel();
		for (const action of RESET_ACTIONS) {
			const btn = (await findByTestId(`repo-reset-${action}-website`)) as HTMLButtonElement;
			expect(btn.disabled).toBe(true);
		}
	} finally {
		restore();
	}
});

test('reset actions are enabled when no run is active', async () => {
	const restore = stubGitState({
		container_running: true,
		clone: RUNNING_CLONE,
		worktrees: [],
		active_runs: 0,
	});
	try {
		const { findByTestId } = await renderExpandedPanel();
		for (const action of RESET_ACTIONS) {
			const btn = (await findByTestId(`repo-reset-${action}-website`)) as HTMLButtonElement;
			expect(btn.disabled).toBe(false);
		}
	} finally {
		restore();
	}
});

test('superuser can expand a repo to inspect its git state', async () => {
	let slug = '';
	const { findByTestId, queryByTestId, user, router } = await renderApp({
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

	// No container is provisioned for the seeded project. The panel says nothing
	// about that any more - Refresh is the whole affordance, and the notice that
	// used to sit here linked to a page with no start control.
	await findByTestId('repo-git-state-website');
	await findByTestId('repo-git-refresh-website');
	expect(queryByTestId('repo-git-container-stopped-website')).toBeNull();
});

test('refresh asks for a container when none is running', async () => {
	let posts = 0;
	const restore = stubGitState({ container_running: false, can_push: true }, () => {
		posts++;
		return new Response(JSON.stringify({ data: { starting: true, container_running: false } }), {
			status: 200,
			headers: JSON_HEADERS,
		});
	});
	try {
		const { findByTestId, queryByTestId, user } = await renderExpandedPanel();
		// Expanding the row is a passive read: it must not start anything.
		expect(posts).toBe(0);
		expect(queryByTestId('repo-git-starting-website')).toBeNull();

		await user.click(await findByTestId('repo-git-refresh-website'));
		await findByTestId('repo-git-starting-website');
		expect(posts).toBe(1);
	} finally {
		restore();
	}
});

test('refresh reports the wait while the instance is at container capacity', async () => {
	const restore = stubGitState(
		{ container_running: false, can_push: true },
		() =>
			new Response(
				JSON.stringify({
					error: { code: 'CONTAINER_AT_CAPACITY', message: 'no memory left for a container' },
				}),
				{ status: 409, headers: JSON_HEADERS },
			),
	);
	try {
		const { findByTestId, user } = await renderExpandedPanel();
		await user.click(await findByTestId('repo-git-refresh-website'));
		// Parked, not failed: the panel keeps asking until a slot frees.
		await findByTestId('repo-git-waiting-capacity-website');
	} finally {
		restore();
	}
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

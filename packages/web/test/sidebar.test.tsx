import { waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedTask, seedWorkspace } from './helpers/seed';

function getNav(container: HTMLElement): HTMLElement {
	const nav = container.querySelector('nav[aria-label="Sidebar"]');
	if (!nav) throw new Error('nav not mounted');
	return nav;
}

test('sidebar shows all top-level sections with the expected nav links', async () => {
	let ws!: SeededWorkspace;
	const { container, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({ to: '/teams/$teamId/tasks', params: { teamId: ws.team.slug } });
	await findByText('Resources', undefined, { timeout: 15_000 });

	const nav = getNav(container);
	expect(within(nav).getByText('Inbox', { exact: true })).toBeTruthy();
	expect(within(nav).getByText('Projects', { exact: true })).toBeTruthy();
	expect(within(nav).getByText('Team', { exact: true })).toBeTruthy();
	expect(within(nav).getByText('Resources', { exact: true })).toBeTruthy();
	expect(within(nav).getByRole('link', { name: 'All Tasks' })).toBeTruthy();
	expect(within(nav).getByRole('link', { name: 'Projects' })).toBeTruthy();
	expect(within(nav).getByRole('link', { name: 'Team' })).toBeTruthy();
});

test('clicking the Team label navigates to the team org chart page', async () => {
	let ws!: SeededWorkspace;
	const { container, findByText, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({ to: '/teams/$teamId/tasks', params: { teamId: ws.team.slug } });
	await findByText('Resources', undefined, { timeout: 15_000 });

	const nav = getNav(container);
	await user.click(within(nav).getByRole('link', { name: 'Team' }));

	expect(router.state.location.pathname).toBe(`/teams/${ws.team.slug}/agents`);
	await findByTestId('team-summary', undefined, { timeout: 15_000 });
});

test('clicking the Projects label navigates to the projects list page', async () => {
	let ws!: SeededWorkspace;
	const { container, findByText, findByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({ to: '/teams/$teamId/tasks', params: { teamId: ws.team.slug } });
	await findByText('Resources', undefined, { timeout: 15_000 });

	const nav = getNav(container);
	await user.click(within(nav).getByRole('link', { name: 'Projects' }));

	expect(router.state.location.pathname).toBe(`/teams/${ws.team.slug}/projects`);
	await findByRole('heading', { name: 'Projects', level: 1 }, { timeout: 15_000 });
});

test('Team section lists agents directly and clicking an agent navigates to its detail page', async () => {
	let ws!: SeededWorkspace;
	const { container, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({ to: '/teams/$teamId/tasks', params: { teamId: ws.team.slug } });

	const nav = await findByText('Captain', undefined, { timeout: 20_000 });
	expect(nav).toBeTruthy();
	const navEl = getNav(container);
	expect(within(navEl).getByText('Architect')).toBeTruthy();

	const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
	await user.click(within(navEl).getByText('Captain'));
	expect(router.state.location.pathname).toMatch(
		new RegExp(`^/teams/${ws.team.slug}/agents/${captain.slug}`),
	);
});

test('Team section collapses, expands, and persists collapse state across navigation', async () => {
	let ws!: SeededWorkspace;
	const { container, findByText, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({ to: '/teams/$teamId/tasks', params: { teamId: ws.team.slug } });
	await findByText('Captain', undefined, { timeout: 20_000 });

	const navEl = getNav(container);
	// The Team section is the only one with both titleTo + collapsible, so its
	// trailing chevron button is labeled "Collapse" (or "Expand" when collapsed).
	const collapseButtons = within(navEl).getAllByRole('button', { name: /Collapse|Expand/ });
	// There are two collapsible sections (Projects, Team); Team is the second.
	await user.click(collapseButtons[1]);

	await new Promise((r) => setTimeout(r, 200));
	expect(within(navEl).queryByText('Captain')).toBeNull();

	// Navigate elsewhere; collapsed state persists.
	await user.click(within(navEl).getByText('Inbox', { exact: true }));
	await new Promise((r) => setTimeout(r, 300));
	expect(queryByText('Captain')).toBeNull();

	// Expand again.
	const expandButtons = within(getNav(container)).getAllByRole('button', { name: /Expand/ });
	await user.click(expandButtons[expandButtons.length - 1]);
	await findByText('Captain', undefined, { timeout: 15_000 });
});

test('Projects section lists projects with (Internal) pinned last and click navigates to detail', async () => {
	let ws!: SeededWorkspace;
	let aardvarkSlug = '';
	const { container, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const aardvark = await seedProject(ws, { name: 'Aardvark' });
			await seedProject(ws, { name: 'Zebra' });
			aardvarkSlug = aardvark.slug;
		},
	});

	await router.navigate({ to: '/teams/$teamId/tasks', params: { teamId: ws.team.slug } });
	await findByText('(Internal)', undefined, { timeout: 20_000 });
	// Wait for all three project entries to appear inside the sidebar nav
	// (the project name shows up in the main content too, so plain findByText
	// trips on duplicates — scope to the nav element).
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const navEl = container.querySelector('nav[aria-label="Sidebar"]');
		const text = navEl?.textContent ?? '';
		if (text.includes('(Internal)') && text.includes('Aardvark') && text.includes('Zebra')) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	const navEl = getNav(container);
	expect(navEl.textContent).toMatch(/Aardvark/);
	expect(navEl.textContent).toMatch(/Zebra/);
	expect(navEl.textContent).toMatch(/\(Internal\)/);
	const projectLinks = within(navEl)
		.getAllByRole('link')
		.filter((a) => {
			const t = a.textContent?.trim() ?? '';
			return t === 'Aardvark' || t === 'Zebra' || t === '(Internal)';
		});
	const texts = projectLinks.map((a) => a.textContent?.trim());
	expect(texts).toEqual(['Aardvark', 'Zebra', '(Internal)']);

	await user.click(within(navEl).getByText('Aardvark'));
	expect(router.state.location.pathname).toMatch(
		new RegExp(`^/teams/${ws.team.slug}/projects/${aardvarkSlug}`),
	);
});

test('Projects section collapses, expands, and persists collapse state across navigation', async () => {
	let ws!: SeededWorkspace;
	const { container, findByText, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({ to: '/teams/$teamId/tasks', params: { teamId: ws.team.slug } });
	await findByText('(Internal)', undefined, { timeout: 20_000 });

	const navEl = getNav(container);
	// Projects section is the FIRST collapsible (above Team).
	const collapseButtons = within(navEl).getAllByRole('button', { name: /Collapse|Expand/ });
	await user.click(collapseButtons[0]);

	await new Promise((r) => setTimeout(r, 200));
	expect(within(getNav(container)).queryByText('(Internal)')).toBeNull();

	await user.click(within(getNav(container)).getByText('Inbox', { exact: true }));
	await new Promise((r) => setTimeout(r, 300));
	expect(queryByText('(Internal)')).toBeNull();

	const expandButtons = within(getNav(container)).getAllByRole('button', { name: /Expand/ });
	await user.click(expandButtons[0]);
	await findByText('(Internal)', undefined, { timeout: 15_000 });
});

test('active project reveals subsection sub-links; inactive projects do not, leaving collapses them', async () => {
	let ws!: SeededWorkspace;
	let alphaSlug = '';
	let betaSlug = '';
	const { container, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const alpha = await seedProject(ws, { name: 'Alpha' });
			const beta = await seedProject(ws, { name: 'Beta' });
			alphaSlug = alpha.slug;
			betaSlug = beta.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId',
		params: { teamId: ws.team.slug, projectId: alphaSlug },
	});
	await findByText('Alpha', undefined, { timeout: 20_000 });

	const navEl = getNav(container);
	// Active project (Alpha) shows sub-links for its sub-routes.
	expect(navEl.querySelector(`a[href$="/projects/${alphaSlug}/tasks"]`)).toBeTruthy();
	expect(navEl.querySelector(`a[href$="/projects/${alphaSlug}/documents"]`)).toBeTruthy();
	expect(navEl.querySelector(`a[href$="/projects/${alphaSlug}/container"]`)).toBeTruthy();
	expect(navEl.querySelector(`a[href$="/projects/${alphaSlug}/settings"]`)).toBeTruthy();

	// Inactive project (Beta) does not.
	expect(navEl.querySelector(`a[href$="/projects/${betaSlug}/tasks"]`)).toBeNull();
	expect(navEl.querySelector(`a[href$="/projects/${betaSlug}/settings"]`)).toBeNull();

	// Navigate via the Documents sub-link.
	await user.click(
		navEl.querySelector(`a[href$="/projects/${alphaSlug}/documents"]`) as HTMLElement,
	);
	expect(router.state.location.pathname).toBe(
		`/teams/${ws.team.slug}/projects/${alphaSlug}/documents`,
	);

	// Then navigate away from Alpha entirely; sub-links collapse.
	await user.click(within(getNav(container)).getByText('Inbox', { exact: true }));
	await new Promise((r) => setTimeout(r, 300));
	expect(getNav(container).querySelector(`a[href$="/projects/${alphaSlug}/settings"]`)).toBeNull();
});

test('creating a project from the sidebar surfaces it in the sidebar after intake approval', async () => {
	let ws!: SeededWorkspace;
	const { container, findByText, findByLabelText, findByRole, getAllByRole, user, router } =
		await renderApp({
			initialPath: '/',
			seed: async () => {
				ws = await seedWorkspace();
			},
		});

	await router.navigate({ to: '/teams/$teamId/projects', params: { teamId: ws.team.slug } });
	// On the projects list route the Internal project renders in both the sidebar
	// nav and the main content, so a plain findByText trips on duplicates — wait
	// for it to appear inside the nav specifically.
	await waitFor(() => expect(within(getNav(container)).getByText('(Internal)')).toBeTruthy(), {
		timeout: 20_000,
	});

	const navEl = getNav(container);
	// The sidebar's Projects section has an "add" button with the addLabel tooltip.
	const addButtons = within(navEl).getAllByRole('button', { name: 'Create a new project' });
	await user.click(addButtons[0]);

	const sidebarProjectName = `Sidebar Created ${Math.random().toString(36).slice(2, 6)}`;
	await user.type(await findByLabelText('Name'), sidebarProjectName);
	await user.type(await findByLabelText('Description'), 'Sidebar-button test project.');

	// Filter the form's Create button (also a Create button in the doc dialog may
	// exist if reused, but here we just want the dialog's submit).
	const createButtons = getAllByRole('button', { name: 'Create' });
	await user.click(createButtons[createButtons.length - 1]);

	// Approve the pending intake approval to materialize the project.
	const ctx = getTestContext();
	const approvalsRes = await ctx.apiBase(`/api/teams/${ws.team.id}/approvals?status=pending`, {
		headers: ws.headers,
	});
	const approvals = (
		(await approvalsRes.json()) as {
			data: Array<{ id: string; type: string; payload: { name?: string } }>;
		}
	).data;
	const intake = approvals.find(
		(a) => a.type === 'project_creation' && a.payload?.name === sidebarProjectName,
	);
	expect(intake).toBeTruthy();
	await ctx.apiBase(`/api/approvals/${intake!.id}/resolve`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({ status: 'approved' }),
	});

	// Navigate back to /projects so the sidebar refetches; assert the new project appears.
	await router.navigate({ to: '/teams/$teamId/projects', params: { teamId: ws.team.slug } });
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const navTxt = container.querySelector('nav[aria-label="Sidebar"]')?.textContent ?? '';
		if (navTxt.includes(sidebarProjectName)) return;
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(
		`project ${sidebarProjectName} did not appear in sidebar nav: ${container.querySelector('nav[aria-label="Sidebar"]')?.textContent}`,
	);
}, 60_000);

test('sidebar Tasks count reflects non-terminal tasks', async () => {
	let ws!: SeededWorkspace;
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Count Project' });
			// Create three tasks; counts derive from open_task_count which is updated server-side.
			for (const title of ['Alpha', 'Beta', 'Gamma']) {
				await seedTask(ws, project, { title });
			}
		},
	});

	await router.navigate({ to: '/teams/$teamId/tasks', params: { teamId: ws.team.slug } });

	// Poll the server count and compare to sidebar badge text.
	const ctx = getTestContext();
	const readOpenCount = async (): Promise<number> => {
		const r = await ctx.apiBase(`/api/teams/${ws.team.slug}`, {
			headers: { Authorization: `Bearer ${ctx.token}` },
		});
		const body = (await r.json()) as { data: { open_task_count: number } };
		return body.data.open_task_count;
	};

	const sidebarTasks = await findByTestId('sidebar-link-tasks', undefined, { timeout: 15_000 });
	expect(sidebarTasks.textContent).toMatch(/Tasks/);

	// The badge renders from team.open_task_count. useTeam fires when the
	// sidebar mounts; wait for the badge to include a numeric count > 0.
	await waitFor(
		async () => {
			const count = await readOpenCount();
			expect(count).toBeGreaterThanOrEqual(3);
			expect(sidebarTasks.textContent ?? '').toMatch(new RegExp(`Tasks\\s*${count}`));
		},
		{ timeout: 15_000 },
	);
}, 30_000);

test('sidebar toggle stays clickable when the container status banner is showing', async () => {
	let ws!: SeededWorkspace;

	const originalFetch = globalThis.fetch;
	const restoreFetch = () => {
		globalThis.fetch = originalFetch;
	};

	const { container, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();

			// Override fetch for the projects-list GET so the banner renders an
			// error-state project at the top of every team page.
			const fakeProject = {
				id: '11111111-1111-1111-1111-000000000099',
				team_id: ws.team.id,
				name: 'Banner Regression Project',
				slug: 'banner-regression-project',
				task_prefix: 'BR',
				description: '',
				docker_base_image: null,
				container_id: null,
				container_status: 'error',
				container_error: 'simulated build failure',
				container_last_logs: null,
				dev_ports: [],
				repo_count: 0,
				open_task_count: 0,
				created_at: new Date().toISOString(),
			};
			const currentFetch = globalThis.fetch;
			globalThis.fetch = (async (
				input: RequestInfo | URL,
				init?: RequestInit,
			): Promise<Response> => {
				const url =
					typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
				const path = new URL(url, 'http://localhost').pathname;
				const method = init?.method ?? 'GET';
				if (method === 'GET' && /^\/api\/teams\/[^/]+\/projects$/.test(path)) {
					return new Response(JSON.stringify({ data: [fakeProject] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return currentFetch(input, init);
			}) as typeof globalThis.fetch;
		},
	});

	try {
		await router.navigate({ to: '/teams/$teamId/inbox', params: { teamId: ws.team.slug } });

		const banner = await findByTestId('container-status-banner', undefined, { timeout: 20_000 });
		expect(banner.textContent).toMatch(/container failed/i);

		const toggle = await findByTestId('sidebar-toggle');
		expect(toggle.getAttribute('aria-label')).toBe('Collapse sidebar');

		// Confirm the toggle is still interactive when the banner is present.
		toggle.click();
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const t = container.querySelector('[data-testid="sidebar-toggle"]') as HTMLElement | null;
			if (t?.getAttribute('aria-label') === 'Expand sidebar') return;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error('sidebar toggle did not flip to Expand after click');
	} finally {
		restoreFetch();
	}
});

test('sidebar collapse hides the sections panel and persists across remount', async () => {
	let ws!: SeededWorkspace;
	const { container, findByText, findByTestId, queryByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({ to: '/teams/$teamId/inbox', params: { teamId: ws.team.slug } });
	await findByText('Resources', undefined, { timeout: 20_000 });

	const toggle = await findByTestId('sidebar-toggle');
	expect(toggle.getAttribute('aria-label')).toBe('Collapse sidebar');

	await user.click(toggle);

	// After collapse, the aria-label flips and the side panel hides its content.
	const collapsedToggle = await findByTestId('sidebar-toggle');
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (collapsedToggle.getAttribute('aria-label') === 'Expand sidebar') break;
		await new Promise((r) => setTimeout(r, 50));
	}
	expect(collapsedToggle.getAttribute('aria-label')).toBe('Expand sidebar');

	// The collapsed wrapper sets w-0 so the inner sidebar is no longer visible.
	const wrapper = container.querySelector('div[aria-hidden="true"]');
	expect(wrapper).toBeTruthy();

	// Expand again restores the sections.
	await user.click(collapsedToggle);
	await findByText('Resources', undefined, { timeout: 15_000 });
	expect(queryByText('Resources')).toBeTruthy();
});

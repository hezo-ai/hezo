import { waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededProject,
	type SeededWorkspace,
	seedProject,
	seedWorkspace,
} from './helpers/seed';

async function closePlanningTask(ws: SeededWorkspace, project: SeededProject): Promise<void> {
	const { apiBase } = getTestContext();
	const tasksRes = await apiBase(`/api/teams/${ws.team.id}/tasks?project_id=${project.id}`, {
		headers: ws.headers,
	});
	const tasks = (
		(await tasksRes.json()) as {
			data: Array<{ id: string; labels: string[] }>;
		}
	).data;
	const planning = tasks.find((t) => (t.labels ?? []).includes('planning'));
	if (!planning) return;
	await apiBase(`/api/teams/${ws.team.id}/tasks/${planning.id}`, {
		method: 'PATCH',
		headers: ws.headers,
		body: JSON.stringify({ status: 'done' }),
	});
}

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

test('creates a project via dialog and navigates to the Captain intake task', async () => {
	let ws!: SeededWorkspace;
	const { findByText, findByLabelText, findByRole, getByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects',
		params: { teamId: ws.team.slug },
	});

	await findByRole('heading', { name: 'Projects', level: 1 });
	await user.click(getByRole('button', { name: 'New project' }));

	const name = uniqueName('Marketing Campaign');
	await user.type(await findByLabelText('Name'), name);
	await user.type(
		await findByLabelText('Description'),
		'Q3 brand push aimed at existing users to drive upsells.',
	);

	await user.click(getByRole('button', { name: 'Create' }));

	// The Create-project handler navigates to the auto-created Captain intake task
	// inside the (Internal) project. Assert on the intake task page chrome.
	await findByText(`Open new project: ${name}`, undefined, { timeout: 30_000 });
}, 60_000);

test('project list shows the default (Internal) project', async () => {
	let ws!: SeededWorkspace;
	const { findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects',
		params: { teamId: ws.team.slug },
	});

	await findByRole('heading', { name: '(Internal)', level: 2 }, { timeout: 15_000 });
});

test('project list shows task and repo counts', async () => {
	let ws!: SeededWorkspace;
	const name = uniqueName('Count Test');
	const { router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name, description: 'Count test project.' });
			await closePlanningTask(ws, project);
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects',
		params: { teamId: ws.team.slug },
	});

	// Scope to <main> — the same project name appears in the sidebar nav, so an
	// unscoped query races the two renders and can match both. Wait for <main>
	// to mount and contain the card link before asserting.
	const card = await waitFor(
		() => {
			const main = document.querySelector('main');
			if (!main) throw new Error('main not mounted yet');
			return within(main).getByRole('link', { name: new RegExp(name) });
		},
		{ timeout: 15_000 },
	);
	expect(card.textContent).toMatch(/0 tasks/);
	expect(card.textContent).toMatch(/0 repos/);
}, 60_000);

test('project card links to project detail', async () => {
	let ws!: SeededWorkspace;
	const name = uniqueName('Linkable Project');
	let projectSlug = '';

	const { findByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const proj = await seedProject(ws, { name, description: 'Linkable project description.' });
			projectSlug = proj.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects',
		params: { teamId: ws.team.slug },
	});

	const heading = await findByRole('heading', { name, level: 2 }, { timeout: 15_000 });
	await user.click(heading);

	// Project index route redirects to /tasks under the hood.
	expect(router.state.location.pathname).toMatch(
		new RegExp(`^/teams/${ws.team.slug}/projects/${projectSlug}(?:/tasks)?$`),
	);
}, 60_000);

test('initial PRD passed at creation is persisted as project doc', async () => {
	let ws!: SeededWorkspace;
	const name = uniqueName('PRD Test Project');
	const prdContent = '# Widget App\n\nA tool for managing widgets efficiently.';
	let docBody: { content: string; filename: string } | null = null;
	let seedError: unknown = null;

	await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			try {
				ws = await seedWorkspace();
				const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

				const intakeRes = await apiBase(`/api/teams/${ws.team.id}/projects`, {
					method: 'POST',
					headers,
					body: JSON.stringify({
						name,
						description: 'Testing initial PRD upload.',
						initial_prd: prdContent,
					}),
				});
				const intakeJson = (await intakeRes.json()) as {
					data?: { approval_id: string };
					error?: unknown;
				};
				if (!intakeJson.data) throw new Error(`intake failed: ${JSON.stringify(intakeJson)}`);
				const { approval_id } = intakeJson.data;

				const resolveRes = await apiBase(`/api/approvals/${approval_id}/resolve`, {
					method: 'POST',
					headers,
					body: JSON.stringify({ status: 'approved' }),
				});
				if (!resolveRes.ok) {
					throw new Error(`resolve failed: ${resolveRes.status} ${await resolveRes.text()}`);
				}

				// The intake project_slug is the Internal project (where the intake
				// task lives). Find the actual created project by matching the name.
				const projectsRes = await apiBase(`/api/teams/${ws.team.id}/projects`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				const projectsJson = (await projectsRes.json()) as {
					data: Array<{ slug: string; name: string }>;
				};
				const project = projectsJson.data.find((p) => p.name === name);
				if (!project) throw new Error(`project '${name}' not found after approval`);
				const projectSlug = project.slug;

				const docRes = await apiBase(
					`/api/teams/${ws.team.id}/projects/${projectSlug}/docs/initial-prd.md`,
					{ headers: { Authorization: `Bearer ${token}` } },
				);
				if (!docRes.ok) {
					throw new Error(`doc fetch failed: ${docRes.status} ${await docRes.text()}`);
				}
				docBody = ((await docRes.json()) as { data: { content: string; filename: string } }).data;
			} catch (e) {
				seedError = e;
			}
		},
	});

	if (seedError) throw seedError;

	expect(docBody).toBeTruthy();
	expect(docBody!.content).toBe(prdContent);
	expect(docBody!.filename).toBe('initial-prd.md');
}, 60_000);

test('Create button stays disabled until both name and description are filled', async () => {
	let ws!: SeededWorkspace;
	const { findByLabelText, findByRole, getByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects',
		params: { teamId: ws.team.slug },
	});

	await findByRole('heading', { name: 'Projects', level: 1 });
	await user.click(getByRole('button', { name: 'New project' }));

	const createBtn = (await findByRole('button', { name: 'Create' })) as HTMLButtonElement;
	expect(createBtn.disabled).toBe(true);

	await user.type(await findByLabelText('Name'), 'My Project');
	expect(createBtn.disabled).toBe(true);

	await user.type(await findByLabelText('Description'), 'A short project description.');
	expect(createBtn.disabled).toBe(false);
});

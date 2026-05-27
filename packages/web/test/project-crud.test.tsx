import { within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

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
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			await seedProject(ws, { name, description: 'Count test project.' });
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects',
		params: { teamId: ws.team.slug },
	});

	// Scope to <main> — the same project name appears in the sidebar nav.
	const main = document.querySelector('main') as HTMLElement;
	await findByText(name, undefined, { timeout: 15_000 });
	const card = within(main).getByRole('link', { name: new RegExp(name) });
	expect(card.textContent).toMatch(/0 tasks/);
	expect(card.textContent).toMatch(/0 repos/);
});

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
});

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
					data?: { approval_id: string; project_slug: string };
					error?: unknown;
				};
				if (!intakeJson.data) throw new Error(`intake failed: ${JSON.stringify(intakeJson)}`);
				const { approval_id, project_slug } = intakeJson.data;

				const resolveRes = await apiBase(`/api/approvals/${approval_id}/resolve`, {
					method: 'POST',
					headers,
					body: JSON.stringify({ status: 'approved' }),
				});
				if (!resolveRes.ok) {
					throw new Error(`resolve failed: ${resolveRes.status} ${await resolveRes.text()}`);
				}

				const listRes = await apiBase(`/api/teams/${ws.team.id}/projects/${project_slug}/docs`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				const listBody = await listRes.json();
				const docRes = await apiBase(
					`/api/teams/${ws.team.id}/projects/${project_slug}/docs/initial-prd.md`,
					{ headers: { Authorization: `Bearer ${token}` } },
				);
				if (!docRes.ok) {
					throw new Error(
						`doc fetch failed: ${docRes.status} ${await docRes.text()} | list=${JSON.stringify(listBody)}`,
					);
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
});

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

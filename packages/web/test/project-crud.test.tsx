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
	const tasksRes = await apiBase(`/api/projects/${project.slug}/tasks`, {
		headers: ws.headers,
	});
	const tasks = (
		(await tasksRes.json()) as {
			data: Array<{ id: string; labels: string[] }>;
		}
	).data;
	const planning = tasks.find((t) => (t.labels ?? []).includes('planning'));
	if (!planning) return;
	await apiBase(`/api/projects/${project.slug}/tasks/${planning.id}`, {
		method: 'PATCH',
		headers: ws.headers,
		body: JSON.stringify({ status: 'done' }),
	});
}

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

// The cross-team project list is Home. A team's New-project button + cards live
// there; there is no per-team projects page in the project-centric IA.
test('creates a project from Home and navigates to the Captain intake task', async () => {
	const { findByText, findByPlaceholderText, findByTestId, findByRole, user, router } =
		await renderApp({
			initialPath: '/',
			seed: async () => {
				const ws = await seedWorkspace();
				// Seed one project so Home shows the list + New project button.
				await seedProject(ws, { name: uniqueName('Existing') });
			},
		});

	await router.navigate({ to: '/home' });
	// The rail also carries a "New project" affordance, so scope to Home's main.
	const mainEl = await waitFor(() => {
		const el = document.querySelector('main');
		if (!el) throw new Error('main not mounted');
		return el as HTMLElement;
	});
	await user.click(await within(mainEl).findByRole('button', { name: 'New project' }));

	const name = uniqueName('Marketing Campaign');
	// CreateProjectWithTeamDialog renders into a Radix portal: placeholders +
	// a team-type pick, then a testid-keyed submit.
	await user.type(await findByPlaceholderText('e.g. Marketing Site'), name);
	await user.type(
		await findByPlaceholderText(/What is this project/),
		'Q3 brand push aimed at existing users to drive upsells.',
	);
	await user.click(await findByTestId('team-type-card-Blank'));
	await user.click(await findByTestId('create-project-submit'));

	// The create flow navigates to the auto-created Captain intake task inside the
	// new team's Internal project.
	await findByText(`Open new project: ${name}`, undefined, { timeout: 30_000 });
}, 60_000);

test('Home lists a seeded project with task and repo counts', async () => {
	const name = uniqueName('Count Test');
	const { router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name, description: 'Count test project.' });
			await closePlanningTask(ws, project);
		},
	});

	await router.navigate({ to: '/home' });

	const card = await waitFor(
		() => {
			const main = document.querySelector('main');
			if (!main) throw new Error('main not mounted yet');
			return within(main).getByRole('link', { name: new RegExp(name) });
		},
		{ timeout: 15_000 },
	);
	expect(card.textContent).toMatch(/tasks/);
	expect(card.textContent).toMatch(/repos/);
}, 60_000);

test('Home project card links to the project detail', async () => {
	const name = uniqueName('Linkable Project');
	let projectSlug = '';
	const { findByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const proj = await seedProject(ws, { name, description: 'Linkable project description.' });
			projectSlug = proj.slug;
		},
	});

	await router.navigate({ to: '/home' });

	// Scope to Home's main — the rail also renders a link with the project name.
	const card = await waitFor(
		() => {
			const main = document.querySelector('main');
			if (!main) throw new Error('main not mounted');
			return within(main).getByRole('link', { name: new RegExp(name) });
		},
		{ timeout: 15_000 },
	);
	await user.click(card);

	expect(router.state.location.pathname).toMatch(new RegExp(`^/projects/${projectSlug}`));
}, 60_000);

test('initial PRD passed at creation is persisted as a project doc', async () => {
	const name = uniqueName('PRD Test Project');
	const prdContent = '# Widget App\n\nA tool for managing widgets efficiently.';
	let docBody: { content: string; filename: string } | null = null;
	let seedError: unknown = null;

	await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			try {
				const ws = await seedWorkspace();
				const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

				const intakeRes = await apiBase(`/api/projects/${ws.internalSlug}/projects`, {
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

				// The intake project_slug is the Internal project; find the created
				// user project by name to read its docs.
				const projectsRes = await apiBase('/api/projects', {
					headers: { Authorization: `Bearer ${token}` },
				});
				const projectsJson = (await projectsRes.json()) as {
					data: Array<{ slug: string; name: string; team_id: string }>;
				};
				const project = projectsJson.data.find((p) => p.name === name && p.team_id === ws.team.id);
				if (!project) throw new Error(`project '${name}' not found after approval`);

				const docRes = await apiBase(`/api/projects/${project.slug}/docs/initial-prd.md`, {
					headers: { Authorization: `Bearer ${token}` },
				});
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

test('Create button stays disabled until name, description, and a team type are set', async () => {
	const { findByPlaceholderText, findByTestId, findByRole, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			await seedProject(ws, { name: uniqueName('Existing') });
		},
	});

	await router.navigate({ to: '/home' });
	const mainEl = await waitFor(() => {
		const el = document.querySelector('main');
		if (!el) throw new Error('main not mounted');
		return el as HTMLElement;
	});
	await user.click(await within(mainEl).findByRole('button', { name: 'New project' }));

	const createBtn = (await findByTestId('create-project-submit')) as HTMLButtonElement;
	expect(createBtn.disabled).toBe(true);

	await user.type(await findByPlaceholderText('e.g. Marketing Site'), 'Some Project');
	expect(createBtn.disabled).toBe(true);

	await user.type(
		await findByPlaceholderText(/What is this project/),
		'A description long enough.',
	);
	await user.click(await findByTestId('team-type-card-Blank'));
	await waitFor(() => expect(createBtn.disabled).toBe(false));
}, 60_000);

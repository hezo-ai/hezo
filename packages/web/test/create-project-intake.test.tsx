import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

test('Create Project form opens an intake ticket and approval, then approving creates the project', async () => {
	let ws!: SeededWorkspace;
	const projectName = uniqueName('Customer Portal');
	const projectSlug = projectName.toLowerCase().replace(/\s+/g, '-');

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

	await findByRole('heading', { name: 'Projects', level: 1 }, { timeout: 15_000 });
	await user.click(getByRole('button', { name: 'New project' }));

	await user.type(await findByLabelText('Name'), projectName);
	await user.type(
		await findByLabelText('Description'),
		'Self-serve portal for customers to manage subscriptions.',
	);

	await user.click(getByRole('button', { name: 'Create' }));

	// Should navigate to the intake task under the internal project.
	await findByText(`Open new project: ${projectName}`, undefined, { timeout: 30_000 });
	expect(router.state.location.pathname).toMatch(
		new RegExp(`^/teams/${ws.team.slug}/projects/internal/tasks/`),
	);

	// Before approval: project does not exist.
	const ctx = getTestContext();
	const beforeRes = await ctx.apiBase(`/api/teams/${ws.team.id}/projects`, {
		headers: ws.headers,
	});
	const beforeProjects = (
		(await beforeRes.json()) as {
			data: Array<{ slug: string }>;
		}
	).data;
	expect(beforeProjects.some((p) => p.slug === projectSlug)).toBe(false);

	// Find the pending approval and resolve it.
	const approvalsRes = await ctx.apiBase(`/api/teams/${ws.team.id}/approvals?status=pending`, {
		headers: ws.headers,
	});
	const approvals = (
		(await approvalsRes.json()) as {
			data: Array<{ id: string; type: string; payload: { name?: string } }>;
		}
	).data;
	const intakeApproval = approvals.find(
		(a) => a.type === 'project_creation' && a.payload?.name === projectName,
	);
	expect(intakeApproval).toBeDefined();

	await ctx.apiBase(`/api/approvals/${intakeApproval!.id}/resolve`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({ status: 'approved' }),
	});

	// After approval: project exists with a planning task.
	const afterRes = await ctx.apiBase(`/api/teams/${ws.team.id}/projects`, {
		headers: ws.headers,
	});
	const afterProjects = (
		(await afterRes.json()) as {
			data: Array<{ id: string; slug: string; name: string }>;
		}
	).data;
	const created = afterProjects.find((p) => p.slug === projectSlug);
	expect(created).toBeDefined();
	expect(created?.name).toBe(projectName);

	const tasksRes = await ctx.apiBase(`/api/teams/${ws.team.id}/tasks?project_id=${created!.id}`, {
		headers: ws.headers,
	});
	const tasks = (
		(await tasksRes.json()) as {
			data: Array<{ title: string; labels: string[] }>;
		}
	).data;
	expect(tasks.some((t) => (t.labels ?? []).includes('planning'))).toBe(true);
}, 60_000);

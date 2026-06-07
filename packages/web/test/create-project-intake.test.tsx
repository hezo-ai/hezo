import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedWorkspace } from './helpers/seed';

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

// Opening a project on an existing team goes through an intake ticket + approval
// before the project row exists. The project is addressed by its team's Internal
// project slug (the project-addressed sibling-create endpoint).
test('opening a project creates an intake + approval, and approving creates the project', async () => {
	let ws!: SeededWorkspace;
	const projectName = uniqueName('Customer Portal');
	const projectSlug = projectName.toLowerCase().replace(/\s+/g, '-');

	await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
		},
	});

	const ctx = getTestContext();

	// Open the project intake on the existing team.
	const intakeRes = await ctx.apiBase(`/api/projects/${ws.internalSlug}/projects`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({
			name: projectName,
			description: 'Self-serve portal for customers to manage subscriptions.',
		}),
	});
	const { approval_id } = ((await intakeRes.json()) as { data: { approval_id: string } }).data;
	expect(approval_id).toBeTruthy();

	// Before approval: the project does not exist yet.
	const beforeProjects = (
		(await (await ctx.apiBase('/api/projects', { headers: ws.headers })).json()) as {
			data: Array<{ slug: string }>;
		}
	).data;
	expect(beforeProjects.some((p) => p.slug === projectSlug)).toBe(false);

	await ctx.apiBase(`/api/approvals/${approval_id}/resolve`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({ status: 'approved' }),
	});

	// After approval: the project exists with a planning task.
	const afterProjects = (
		(await (await ctx.apiBase('/api/projects', { headers: ws.headers })).json()) as {
			data: Array<{ id: string; slug: string; name: string; team_id: string }>;
		}
	).data;
	const created = afterProjects.find((p) => p.slug === projectSlug && p.team_id === ws.team.id);
	expect(created).toBeDefined();
	expect(created?.name).toBe(projectName);

	const tasks = (
		(await (
			await ctx.apiBase(`/api/projects/${created!.slug}/tasks`, {
				headers: ws.headers,
			})
		).json()) as { data: Array<{ title: string; labels: string[] }> }
	).data;
	expect(tasks.some((t) => (t.labels ?? []).includes('planning'))).toBe(true);
}, 60_000);

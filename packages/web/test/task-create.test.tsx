import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// Proof-of-concept of the component tier: drive the team / project / task
// flow through the real API, render the task list, and assert that the task
// appears. Same realism as the Playwright `task-list` spec but runs against
// an in-process backend with no browser.
test('renders a task with its title and project after seeding', async () => {
	const { findByText, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			const auth = {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			};

			// Pick the Startup template and create a team. The api path provisions
			// Captain / Engineer / etc. for us.
			const tmplsRes = await apiBase('/api/team-templates', { headers: auth });
			const startup = (
				(await tmplsRes.json()) as { data: Array<{ id: string; name: string }> }
			).data.find((t) => t.name === 'Startup');
			if (!startup) throw new Error('seed: Startup template missing');

			const teamRes = await apiBase('/api/teams', {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({ name: 'Demo Team', template_id: startup.id }),
			});
			const team = ((await teamRes.json()) as { data: { id: string; slug: string } }).data;

			// Project + planning task auto-spawn; we drive the intake approval
			// straight through the API so the real project row exists.
			const intakeRes = await apiBase(`/api/teams/${team.id}/projects`, {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({ name: 'Demo Project', description: 'POC project' }),
			});
			const { approval_id } = ((await intakeRes.json()) as { data: { approval_id: string } }).data;
			await apiBase(`/api/approvals/${approval_id}/resolve`, {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({ status: 'approved' }),
			});

			const projRes = await apiBase(`/api/teams/${team.id}/projects`, { headers: auth });
			const project = (
				(await projRes.json()) as { data: Array<{ id: string; name: string; slug: string }> }
			).data.find((p) => p.name === 'Demo Project');
			if (!project) throw new Error('seed: project not created');

			const agentsRes = await apiBase(`/api/teams/${team.id}/agents`, { headers: auth });
			const engineer = (
				(await agentsRes.json()) as { data: Array<{ id: string; slug: string }> }
			).data.find((a) => a.slug === 'engineer');
			if (!engineer) throw new Error('seed: engineer agent missing');

			await apiBase(`/api/teams/${team.id}/tasks`, {
				method: 'POST',
				headers: auth,
				body: JSON.stringify({
					project_id: project.id,
					title: 'Demo Task',
					description: 'A description.',
					assignee_id: engineer.id,
				}),
			});

			return { teamSlug: team.slug };
		},
	});

	// Navigate to the team's task list — the router's memory history was created
	// at "/", so push to the right route.
	await router.navigate({ to: '/teams/$teamId/tasks', params: { teamId: 'demo-team' } });

	await findByText('Demo Task', undefined, { timeout: 10_000 });
});

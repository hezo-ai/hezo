import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

interface IntakeResult {
	intake_task_id: string;
	intake_task_identifier: string;
	approval_id: string;
	project_slug: string;
	team_id: string;
	team_slug: string;
}

// CEO-assisted intake: POST /api/project-intakes stands up a new team and opens
// an HQ conversation assigned to the CEO plus a pending project_creation
// approval. The project itself is only created when the approval is approved.
test('starting an intake opens an HQ conversation + pending approval, no project yet', async () => {
	const projectName = uniqueName('Customer Portal');
	const projectSlug = projectName.toLowerCase().replace(/\s+/g, '-');

	await renderApp({ initialPath: '/', seed: async () => {} });
	const ctx = getTestContext();
	const headers = { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' };

	const intakeRes = await ctx.apiBase('/api/project-intakes', {
		method: 'POST',
		headers,
		body: JSON.stringify({
			name: projectName,
			description: 'Self-serve portal for customers to manage subscriptions.',
		}),
	});
	expect(intakeRes.status).toBe(201);
	const intake = ((await intakeRes.json()) as { data: IntakeResult }).data;

	// The conversation lives in HQ; the team is fresh and has no project yet.
	expect(intake.project_slug).toBe('hq');
	expect(intake.intake_task_identifier).toMatch(/^HQ-\d+$/);
	expect(intake.approval_id).toBeTruthy();
	expect(intake.team_id).toBeTruthy();

	// The target project does not exist on the new team before approval.
	const beforeProjects = (
		(await (await ctx.apiBase('/api/projects', { headers })).json()) as {
			data: Array<{ slug: string; team_id: string }>;
		}
	).data;
	expect(beforeProjects.some((p) => p.team_id === intake.team_id)).toBe(false);

	// The CEO opens the intake thread with a greeting.
	const comments = (
		(await (
			await ctx.apiBase(
				`/api/projects/${intake.project_slug}/tasks/${intake.intake_task_identifier.toLowerCase()}/comments`,
				{ headers },
			)
		).json()) as { data: Array<{ content: { text?: string } }> }
	).data;
	expect(comments.some((c) => (c.content.text ?? '').includes("I'm the CEO"))).toBe(true);

	// Sanity: the slug we expect the project to take once approved.
	expect(projectSlug).toBe(projectName.toLowerCase().replace(/\s+/g, '-'));
});

test('approving the intake creates the project + planning task on the new team', async () => {
	const projectName = uniqueName('Mobile App');
	const projectSlug = projectName.toLowerCase().replace(/\s+/g, '-');

	await renderApp({ initialPath: '/', seed: async () => {} });
	const ctx = getTestContext();
	const headers = { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' };

	const intakeRes = await ctx.apiBase('/api/project-intakes', {
		method: 'POST',
		headers,
		body: JSON.stringify({
			name: projectName,
			description: 'A new mobile app for our customers.',
		}),
	});
	const intake = ((await intakeRes.json()) as { data: IntakeResult }).data;

	const resolveRes = await ctx.apiBase(`/api/approvals/${intake.approval_id}/resolve`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ status: 'approved' }),
	});
	expect(resolveRes.ok).toBe(true);

	// After approval: the project exists on the intake's team.
	const afterProjects = (
		(await (await ctx.apiBase('/api/projects', { headers })).json()) as {
			data: Array<{ id: string; slug: string; name: string; team_id: string }>;
		}
	).data;
	const created = afterProjects.find((p) => p.slug === projectSlug && p.team_id === intake.team_id);
	expect(created).toBeDefined();
	expect(created?.name).toBe(projectName);

	// It comes with a Captain planning task.
	const tasks = (
		(await (await ctx.apiBase(`/api/projects/${created!.slug}/tasks`, { headers })).json()) as {
			data: Array<{ title: string; labels: string[] }>;
		}
	).data;
	expect(tasks.some((t) => (t.labels ?? []).includes('planning'))).toBe(true);
}, 60_000);

test('missing name/description is rejected with 400 and creates no approval', async () => {
	await renderApp({ initialPath: '/', seed: async () => {} });
	const ctx = getTestContext();
	const headers = { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' };

	const res = await ctx.apiBase('/api/project-intakes', {
		method: 'POST',
		headers,
		body: JSON.stringify({ name: '', description: 'desc' }),
	});
	expect(res.status).toBe(400);

	const approvals = await ctx.db.query<{ count: number }>(
		`SELECT count(*)::int AS count FROM approvals WHERE type = 'project_creation'::approval_type`,
	);
	expect(approvals.rows[0].count).toBe(0);
});

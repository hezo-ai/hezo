import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

interface IntakeResult {
	intake_task_id: string;
	intake_task_identifier: string;
	project_slug: string;
}

// CEO-assisted intake: POST /api/project-intakes opens an HQ conversation
// assigned to the CEO. Nothing is created up front — no team, no project, no
// approval. The CEO creates the project + team itself (via the create_project
// MCP tool) once the admin approves in the thread.
test('starting an intake opens an HQ conversation; no team, project, or approval is created', async () => {
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

	// The conversation lives in HQ.
	expect(intake.project_slug).toBe('hq');
	expect(intake.intake_task_identifier).toMatch(/^HQ-\d+$/);

	// No approval row is created.
	const approvals = await ctx.db.query<{ count: number }>(
		'SELECT count(*)::int AS count FROM approvals',
	);
	expect(approvals.rows[0].count).toBe(0);

	// The target project does not exist yet.
	const projects = (
		(await (await ctx.apiBase('/api/projects', { headers })).json()) as {
			data: Array<{ slug: string }>;
		}
	).data;
	expect(projects.some((p) => p.slug === projectSlug)).toBe(false);

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
});

test('missing name/description is rejected with 400 and creates nothing', async () => {
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
		'SELECT count(*)::int AS count FROM approvals',
	);
	expect(approvals.rows[0].count).toBe(0);
});

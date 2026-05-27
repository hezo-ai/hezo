// Server-side seeders driven through the in-process Hono API. Same shape as
// the helpers in test/e2e/helpers.ts but reusable across component tests so
// each spec doesn't redefine the team-with-project-and-task ritual.

import { getTestContext } from './render';

type Auth = {
	Authorization: string;
	'Content-Type': string;
};

function authHeaders(token: string): Auth {
	return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export interface SeededWorkspace {
	team: { id: string; slug: string };
	agents: Array<{ id: string; slug: string; title: string }>;
	token: string;
	headers: Auth;
}

/**
 * Create a Startup-templated team with the full agent roster. Cheap inside
 * the component tier because HEZO_E2E_SKIP_COHERENCE_REVIEW skips Captain's
 * coherence-review run and the synthetic exec finishes in milliseconds.
 */
export async function seedWorkspace(): Promise<SeededWorkspace> {
	const { token, apiBase } = getTestContext();
	const headers = authHeaders(token);

	const tmplsRes = await apiBase('/api/team-templates', { headers });
	const startup = (
		(await tmplsRes.json()) as { data: Array<{ id: string; name: string }> }
	).data.find((t) => t.name === 'Startup');
	if (!startup) throw new Error('seedWorkspace: Startup template missing');

	const teamRes = await apiBase('/api/teams', {
		method: 'POST',
		headers,
		body: JSON.stringify({ name: 'Demo Team', template_id: startup.id }),
	});
	const team = ((await teamRes.json()) as { data: { id: string; slug: string } }).data;

	const agentsRes = await apiBase(`/api/teams/${team.id}/agents`, { headers });
	const agents = (
		(await agentsRes.json()) as {
			data: Array<{ id: string; slug: string; title: string }>;
		}
	).data;

	return { team, agents, token, headers };
}

export interface SeededProject {
	id: string;
	slug: string;
	name: string;
}

/**
 * Drive the project intake flow end-to-end through the API: POST /projects to
 * open the intake, resolve the auto-created approval, return the created
 * project row.
 */
export async function seedProject(
	workspace: SeededWorkspace,
	input: { name: string; description?: string },
): Promise<SeededProject> {
	const { apiBase } = getTestContext();
	const intakeRes = await apiBase(`/api/teams/${workspace.team.id}/projects`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify({ description: 'Seeded for component test.', ...input }),
	});
	const { approval_id } = ((await intakeRes.json()) as { data: { approval_id: string } }).data;
	await apiBase(`/api/approvals/${approval_id}/resolve`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify({ status: 'approved' }),
	});

	const projectsRes = await apiBase(`/api/teams/${workspace.team.id}/projects`, {
		headers: workspace.headers,
	});
	const project = (
		(await projectsRes.json()) as { data: Array<{ id: string; slug: string; name: string }> }
	).data.find((p) => p.name === input.name);
	if (!project) throw new Error(`seedProject: '${input.name}' not found after approval`);
	return project;
}

export interface SeededTask {
	id: string;
	identifier: string;
	title: string;
}

export async function seedTask(
	workspace: SeededWorkspace,
	project: SeededProject,
	input: { title: string; description?: string; assignee_id?: string },
): Promise<SeededTask> {
	const { apiBase } = getTestContext();
	const assigneeId = input.assignee_id ?? workspace.agents[0].id;
	const res = await apiBase(`/api/teams/${workspace.team.id}/tasks`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify({
			project_id: project.id,
			assignee_id: assigneeId,
			title: input.title,
			description: input.description,
		}),
	});
	const task = ((await res.json()) as { data: SeededTask }).data;
	return task;
}

export async function seedComment(
	workspace: SeededWorkspace,
	task: SeededTask,
	body: string,
): Promise<{ id: string }> {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/teams/${workspace.team.id}/tasks/${task.id}/comments`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify({ content_type: 'text', content: { text: body } }),
	});
	return ((await res.json()) as { data: { id: string } }).data;
}

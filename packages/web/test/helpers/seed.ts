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

export interface SeededAsset {
	id: string;
	original_filename: string;
	content_type: string;
	url: string;
}

/** Upload a file to the project assets library via the real API. */
export async function seedAsset(
	workspace: SeededWorkspace,
	project: SeededProject,
	input: { filename: string; contentType?: string; bytes?: Uint8Array },
): Promise<SeededAsset> {
	const { apiBase } = getTestContext();
	const bytes = input.bytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
	const fd = new FormData();
	fd.set('file', new File([bytes], input.filename, { type: input.contentType ?? 'image/png' }));
	const res = await apiBase(`/api/teams/${workspace.team.id}/projects/${project.id}/assets`, {
		method: 'POST',
		// No Content-Type header: let fetch set the multipart boundary.
		headers: { Authorization: workspace.headers.Authorization },
		body: fd,
	});
	return ((await res.json()) as { data: SeededAsset }).data;
}

export async function seedComment(
	workspace: SeededWorkspace,
	task: SeededTask,
	body: string,
	opts?: { authorMemberId?: string },
): Promise<{ id: string }> {
	const { apiBase, db } = getTestContext();
	// The API attributes authorship to the board token, so it can only produce
	// author_type: 'user'. To seed an agent-authored comment, insert directly.
	if (opts?.authorMemberId) {
		const inserted = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text', $3::jsonb)
			 RETURNING id`,
			[task.id, opts.authorMemberId, JSON.stringify({ text: body })],
		);
		return { id: inserted.rows[0].id };
	}
	const res = await apiBase(`/api/teams/${workspace.team.id}/tasks/${task.id}/comments`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify({ content_type: 'text', content: { text: body } }),
	});
	return ((await res.json()) as { data: { id: string } }).data;
}

/**
 * Put an agent into the "running on this task" state the way a live run does:
 * a running `heartbeat_runs` row, the `run` task comment that carries the run id
 * to the client, and the execution lock that drives the sidebar's running list.
 * `wakeup_id` is nullable, so no wakeup row is needed.
 */
export async function seedRunningAgent(
	workspace: SeededWorkspace,
	task: SeededTask,
	agentId: string,
): Promise<{ runId: string; lockId: string; commentId: string }> {
	const { db } = getTestContext();

	const titleRes = await db.query<{ title: string }>(
		`SELECT title FROM member_agents WHERE id = $1`,
		[agentId],
	);
	const agentTitle = titleRes.rows[0]?.title ?? 'Agent';

	const runRes = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
		 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now())
		 RETURNING id`,
		[agentId, workspace.team.id, task.id],
	);
	const runId = runRes.rows[0].id;

	const commentRes = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'run'::comment_content_type, $3::jsonb)
		 RETURNING id`,
		[
			task.id,
			agentId,
			JSON.stringify({ run_id: runId, agent_id: agentId, agent_title: agentTitle }),
		],
	);
	const commentId = commentRes.rows[0].id;

	const lockRes = await db.query<{ id: string }>(
		`INSERT INTO execution_locks (task_id, member_id, lock_type)
		 VALUES ($1, $2, 'read')
		 RETURNING id`,
		[task.id, agentId],
	);
	const lockId = lockRes.rows[0].id;

	return { runId, lockId, commentId };
}

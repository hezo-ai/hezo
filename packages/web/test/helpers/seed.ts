// Server-side seeders driven through the in-process Hono API. Same shape as
// the helpers in test/e2e/helpers.ts but reusable across component tests so
// each spec doesn't redefine the team-with-project-and-task ritual.
//
// Under the 1:1 teams↔projects model a team backs exactly one project. A
// workspace is therefore a team plus its single project; `seedProject` just
// names that project (a team can never hold a second one).

import { createTestProject, createTestTeam } from '@hezo/server/test/helpers/app';
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
	/** The team's single project slug — the project handle for team-wide ops. */
	internalSlug: string;
	agents: Array<{ id: string; slug: string; title: string; human_name?: string | null }>;
	token: string;
	headers: Auth;
}

/**
 * Create a App Team-templated team with the full agent roster and its single
 * project. Cheap inside the component tier because
 * HEZO_E2E_SKIP_COHERENCE_REVIEW skips Captain's coherence-review run and the
 * synthetic exec finishes in milliseconds.
 */
export async function seedWorkspace(): Promise<SeededWorkspace> {
	const { token, apiBase, db } = getTestContext();
	const headers = authHeaders(token);

	const tmplsRes = await apiBase('/api/team-templates', { headers });
	const startup = (
		(await tmplsRes.json()) as { data: Array<{ id: string; name: string }> }
	).data.find((t) => t.name === 'App Team');
	if (!startup) throw new Error('seedWorkspace: App Team template missing');

	const teamRes = await createTestTeam(db, { name: 'Demo Team', template_id: startup.id });
	const team = (await teamRes.json()).data;

	// The team's single project; everything project-scoped resolves through it.
	const projectRes = await createTestProject(db, team.id, { name: 'Demo Project' });
	const internalSlug = (await projectRes.json()).data.slug;

	const agentsRes = await apiBase(`/api/projects/${internalSlug}/agents`, { headers });
	const agents = (
		(await agentsRes.json()) as {
			data: Array<{ id: string; slug: string; title: string; human_name?: string | null }>;
		}
	).data;

	return { team, internalSlug, agents, token, headers };
}

export interface SeededProject {
	id: string;
	slug: string;
	name: string;
}

/**
 * Name the workspace's single project. With 1:1 teams↔projects the team already
 * owns exactly one project (created by `seedWorkspace`); this renames it to the
 * requested name and returns it.
 */
export async function seedProject(
	workspace: SeededWorkspace,
	input: { name: string; description?: string },
): Promise<SeededProject> {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${workspace.internalSlug}`, {
		method: 'PATCH',
		headers: workspace.headers,
		body: JSON.stringify({ name: input.name, description: input.description }),
	});
	const project = ((await res.json()) as { data: { id: string; slug: string; name: string } }).data;
	// Renaming reslugs the project; keep the workspace handle in sync so helpers
	// keyed on `internalSlug` (e.g. seedComment) keep resolving the same project.
	workspace.internalSlug = project.slug;
	return { id: project.id, slug: project.slug, name: project.name };
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
	const res = await apiBase(`/api/projects/${project.slug}/tasks`, {
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

/**
 * Set a task's agent-maintained progress summary directly. Agents write it from
 * inside a run via `update_task`; the REST route rejects a human write, so there
 * is no API path a test can use.
 */
export async function seedTaskProgress(task: SeededTask, summary: string): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`UPDATE tasks
		 SET progress_summary = $1,
		     progress_summary_updated_at = now()
		 WHERE id = $2`,
		[summary, task.id],
	);
}

export interface SeededGoal {
	id: string;
	title: string;
}

/** Create a goal on a project via the real API. */
export async function seedGoal(
	workspace: SeededWorkspace,
	project: SeededProject,
	input: {
		title: string;
		measurement?: string;
		actions?: string;
		check_frequency?: string;
		target_date?: string;
		/** Captain-written narrative. No create/update API field exists, so set it directly. */
		statusBlurb?: string;
	},
): Promise<SeededGoal> {
	const { apiBase, db } = getTestContext();
	const { statusBlurb, ...createInput } = input;
	const res = await apiBase(`/api/projects/${project.slug}/goals`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify(createInput),
	});
	const goal = ((await res.json()) as { data: SeededGoal }).data;
	if (statusBlurb !== undefined) {
		await db.query(`UPDATE goals SET status_blurb = $1 WHERE id = $2`, [statusBlurb, goal.id]);
	}
	return goal;
}

/** Set a project's Captain-maintained progress summary directly (no agent run needed). */
export async function seedProjectProgress(project: SeededProject, summary: string): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`UPDATE projects
		 SET progress_summary = $1,
		     progress_summary_updated_at = now()
		 WHERE id = $2`,
		[summary, project.id],
	);
}

export interface SeededAsset {
	id: string;
	original_filename: string;
	content_type: string;
	url: string;
}

/** Upload a file to the project assets library via the real API. A `folder`
 * places it inside a library folder (a `/` in `filename` itself would be
 * stripped by the server's basename normalization). */
export async function seedAsset(
	workspace: SeededWorkspace,
	project: SeededProject,
	input: { filename: string; contentType?: string; bytes?: Uint8Array; folder?: string },
): Promise<SeededAsset> {
	const { apiBase } = getTestContext();
	const bytes = input.bytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
	const fd = new FormData();
	fd.set(
		'file',
		new File([bytes as BlobPart], input.filename, {
			type: input.contentType ?? 'image/png',
		}),
	);
	if (input.folder) fd.set('folder', input.folder);
	const res = await apiBase(`/api/projects/${project.slug}/assets`, {
		method: 'POST',
		// No Content-Type header: let fetch set the multipart boundary.
		headers: { Authorization: workspace.headers.Authorization },
		body: fd,
	});
	return ((await res.json()) as { data: SeededAsset }).data;
}

export interface SeededDocument {
	id: string;
	filename: string;
	updated_at: string;
}

/** Create (or overwrite) a markdown project doc via the real API. */
export async function seedDocument(
	workspace: SeededWorkspace,
	project: SeededProject,
	input: { filename: string; content: string },
): Promise<SeededDocument> {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${project.slug}/docs/${input.filename}`, {
		method: 'PUT',
		headers: workspace.headers,
		body: JSON.stringify({ content: input.content }),
	});
	return ((await res.json()) as { data: SeededDocument }).data;
}

/** Archive (or restore) an asset via the real API. */
export async function archiveSeededAsset(
	workspace: SeededWorkspace,
	project: SeededProject,
	assetId: string,
	archived = true,
): Promise<void> {
	const { apiBase } = getTestContext();
	await apiBase(`/api/projects/${project.slug}/assets/${assetId}`, {
		method: 'PATCH',
		headers: workspace.headers,
		body: JSON.stringify({ archived }),
	});
}

/** Archive (or restore) a project doc via the real API. */
export async function archiveSeededDocument(
	workspace: SeededWorkspace,
	project: SeededProject,
	filename: string,
	archived = true,
): Promise<void> {
	const { apiBase } = getTestContext();
	await apiBase(`/api/projects/${project.slug}/docs/${filename}`, {
		method: 'PATCH',
		headers: workspace.headers,
		body: JSON.stringify({ archived }),
	});
}

/** Archive (or restore) a project via the real API (superuser-only endpoints). */
export async function archiveSeededProject(
	workspace: SeededWorkspace,
	project: SeededProject,
	archived = true,
): Promise<void> {
	const { apiBase } = getTestContext();
	await apiBase(`/api/projects/${project.slug}/${archived ? 'archive' : 'unarchive'}`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify({}),
	});
}

/** Leave a review comment on an asset via the real API (no quote = whole-asset). */
export async function seedAssetReviewComment(
	workspace: SeededWorkspace,
	project: SeededProject,
	assetId: string,
	input: { quote?: string; occurrence?: number; comment: string },
): Promise<{ id: string }> {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${project.slug}/assets/${assetId}/review-comments`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify({
			quote: input.quote,
			occurrence: input.occurrence,
			comment: input.comment,
		}),
	});
	return ((await res.json()) as { data: { id: string } }).data;
}

/** Leave a review comment on a project doc via the real API. */
export async function seedReviewComment(
	workspace: SeededWorkspace,
	project: SeededProject,
	filename: string,
	input: { quote: string; occurrence?: number; comment: string },
): Promise<{ id: string }> {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${project.slug}/docs/${filename}/review-comments`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify({
			quote: input.quote,
			occurrence: input.occurrence ?? 0,
			comment: input.comment,
		}),
	});
	return ((await res.json()) as { data: { id: string } }).data;
}

export async function seedComment(
	workspace: SeededWorkspace,
	task: SeededTask,
	body: string,
	opts?: { authorMemberId?: string },
): Promise<{ id: string; public_id: string }> {
	const { apiBase, db } = getTestContext();
	// The API attributes authorship to the board token, so it can only produce
	// author_type: 'user'. To seed an agent-authored comment, insert directly.
	if (opts?.authorMemberId) {
		const inserted = await db.query<{ id: string; public_id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text', $3::jsonb)
			 RETURNING id, public_id`,
			[task.id, opts.authorMemberId, JSON.stringify({ text: body })],
		);
		return inserted.rows[0];
	}
	const res = await apiBase(`/api/projects/${workspace.internalSlug}/tasks/${task.id}/comments`, {
		method: 'POST',
		headers: workspace.headers,
		body: JSON.stringify({ content_type: 'text', content: { text: body } }),
	});
	return ((await res.json()) as { data: { id: string; public_id: string } }).data;
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

/**
 * Seed a completed Captain progress-update run (the heartbeat run with no task, kind
 * 'progress_update') and, when a goal is given, the progress snapshot it recorded. Mirrors
 * what `tryDispatchProgressUpdate` + `recordGoalProgress` produce, so the dashboard and
 * goal detail run feed render against real rows.
 */
export async function seedProgressUpdateRun(
	workspace: SeededWorkspace,
	opts: {
		goal?: SeededGoal;
		progressPercent?: number;
		health?: string;
		statusBlurb?: string;
		/**
		 * Attribute these existing tasks to the run as goal-linked "created" tasks, so the run's
		 * `created_tasks` activity is populated the way `tryDispatchProgressUpdate` + `create_task` produce.
		 */
		createdTasks?: SeededTask[];
	} = {},
): Promise<{ runId: string }> {
	const { db } = getTestContext();
	const captain = workspace.agents.find((a) => a.slug === 'captain');
	if (!captain) throw new Error('seedProgressUpdateRun: captain agent missing');

	const runRes = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, team_id, status, kind, started_at, finished_at)
		 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, 'progress_update'::heartbeat_run_kind, now(), now())
		 RETURNING id`,
		[captain.id, workspace.team.id],
	);
	const runId = runRes.rows[0].id;

	if (opts.goal) {
		await db.query(
			`INSERT INTO goal_run_updates (run_id, goal_id, progress_percent, health, status_blurb)
			 VALUES ($1, $2, $3, $4::goal_health, $5)`,
			[
				runId,
				opts.goal.id,
				opts.progressPercent ?? 25,
				opts.health ?? 'on_track',
				opts.statusBlurb ?? '',
			],
		);
	}

	if (opts.goal && opts.createdTasks?.length) {
		for (const t of opts.createdTasks) {
			await db.query(`UPDATE tasks SET goal_id = $1, created_by_run_id = $2 WHERE id = $3`, [
				opts.goal.id,
				runId,
				t.id,
			]);
		}
	}

	return { runId };
}

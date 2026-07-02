import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	type AuditActorType,
	CAPTAIN_AGENT_SLUG,
	TaskPriority,
	TaskStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import type { DomainEventBus } from '../events/bus';
import { trackBackground } from '../lib/background';
import { broadcastProjectsChanged, broadcastRowChange } from '../lib/broadcast';
import { toProjectTaskPrefix, toSlug, uniqueSlug } from '../lib/slug';
import { withTransaction } from '../lib/sql';
import { allocateTaskIdentifier } from '../lib/task-identifier';
import { logger } from '../logger';
import { type ContainerDeps, type ProjectRow, provisionContainer } from './containers';
import { enqueueTeamCoherenceReviewTask } from './description-tasks';
import { snapshotTeamAsTemplate } from './team-template-snapshot';
import { type CreatedTeamRow, createTeam } from './teams';
import { createWakeup } from './wakeup';

const log = logger.child('project-create');

/**
 * Project documents seeded into every new project. These are starting-point
 * templates the team fills in — project-specific knowledge that does not belong
 * in the team-wide skills database.
 */
const DEFAULT_PROJECT_DOCS: ReadonlyArray<{ slug: string; title: string; content: string }> = [
	{
		slug: 'architecture-guidelines.md',
		title: 'Architecture Guidelines',
		content: `# Architecture Guidelines

<!-- TODO: customize for your tech stack -->

## Tech Stack

Describe your primary languages, frameworks, and infrastructure.

## Project Structure

Describe your repository layout and key directories.

## Coding Conventions

- Follow the language's standard style guide
- Write self-documenting code with minimal comments
- Prefer composition over inheritance
- Keep functions focused and small

## Architecture Decision Records

Significant technical decisions should be documented with:
- **Context** — what prompted the decision
- **Decision** — what was chosen
- **Consequences** — trade-offs and implications
`,
	},
];

export interface CreateProjectWithPlanningInput {
	teamId: string;
	captainMemberId: string;
	name: string;
	slug: string;
	taskPrefix: string;
	description: string;
	dockerBaseImage?: string;
	initialProjectPlan?: string | null;
	/** Optional audit context: who created the project and the bus to emit on. */
	events?: DomainEventBus;
	actorType?: AuditActorType;
	actorMemberId?: string | null;
}

export interface CreateProjectResult {
	project: Record<string, unknown>;
	/** True when this was the first user-facing project at insert time (defer Captain planning wakeup). */
	deferCaptainPlanningWake: boolean;
}

export interface CreateProjectWithPlanningResult extends CreateProjectResult {
	planningTask: Record<string, unknown>;
}

/**
 * Create the project row, its task counter, and seed docs (incl. any attached
 * project plan). The planning task is created separately by `createPlanningTask` so a
 * caller can slot other tickets (e.g. the CEO coherence review) ahead of it and
 * control identifier ordering. Emits the project.created audit event.
 */
export async function createProject(
	db: PGlite,
	input: CreateProjectWithPlanningInput,
): Promise<CreateProjectResult> {
	const projectName = input.name.trim();
	const projectDescription = input.description.trim();
	const initialProjectPlan = input.initialProjectPlan?.trim() || null;

	const result = await withTransaction(db, async () => {
		await db.query('SELECT id FROM teams WHERE id = $1 FOR UPDATE', [input.teamId]);
		const countResult = await db.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM projects
			 WHERE team_id = $1 AND is_internal = false`,
			[input.teamId],
		);
		const deferCaptainPlanningWake = Number(countResult.rows[0]?.count ?? 0) === 0;

		const projectResult = await db.query(
			`INSERT INTO projects (team_id, name, slug, task_prefix, description, docker_base_image)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 RETURNING *`,
			[
				input.teamId,
				projectName,
				input.slug,
				input.taskPrefix,
				projectDescription,
				input.dockerBaseImage ?? 'hezo/agent-base:latest',
			],
		);
		const project = projectResult.rows[0] as Record<string, unknown>;

		await db.query('INSERT INTO project_task_counters (project_id, next_number) VALUES ($1, 1)', [
			project.id,
		]);

		if (initialProjectPlan) {
			await db.query(
				`INSERT INTO documents (project_id, team_id, type, slug, content)
				 VALUES ($1, $2, 'project_doc', 'project-plan.md', $3)`,
				[project.id, input.teamId, initialProjectPlan],
			);
		}

		for (const doc of DEFAULT_PROJECT_DOCS) {
			await db.query(
				`INSERT INTO documents (project_id, team_id, type, slug, title, content)
				 VALUES ($1, $2, 'project_doc', $3, $4, $5)`,
				[project.id, input.teamId, doc.slug, doc.title, doc.content],
			);
		}

		return { project, deferCaptainPlanningWake };
	});

	input.events?.emit({
		type: 'project.created',
		teamId: input.teamId,
		projectId: result.project.id as string,
		actorType: input.actorType ?? 'admin',
		actorMemberId: input.actorMemberId ?? null,
		name: result.project.name as string,
		slug: result.project.slug as string,
	});

	return result;
}

/**
 * Create the Captain's execution-plan ticket for a project. Allocates the next
 * project task identifier — call this after any ticket that should precede it
 * (e.g. the CEO coherence review, so it lands first).
 */
export async function createPlanningTask(
	db: PGlite,
	input: {
		teamId: string;
		project: Record<string, unknown>;
		captainMemberId: string;
		name: string;
		description: string;
		initialProjectPlan?: string | null;
	},
): Promise<{ planningTask: Record<string, unknown> }> {
	const projectName = input.name.trim();
	const projectDescription = input.description.trim();
	const initialProjectPlan = input.initialProjectPlan?.trim() || null;
	const projectId = input.project.id as string;

	const { number: taskNumber, identifier } = await allocateTaskIdentifier(db, projectId);

	const initialProjectPlanNote = initialProjectPlan
		? `\n\n> **Note:** The admin has provided a project plan document saved as \`project-plan.md\` in this project's docs. Use it as the starting point for planning — for a software team this is the brief the Product Lead turns into the formal PRD; otherwise consult it directly as the plan.`
		: '';

	const taskBody = `## Draft the execution plan for this new project

A new project has just been created. Please read the description below carefully and produce an execution plan.

### Project: ${projectName}

**Description**

${projectDescription}${initialProjectPlanNote}

### Your task

1. Read the description above. If anything is ambiguous, post a clarifying comment on this task for the admin.
2. Use \`list_agents\` / \`get_agent_system_prompt\` to recall who is on the team.
3. Break the work into 3-8 top-level milestones. Write a short scope note for each.
4. Post the plan as a comment on this task. Then create the milestone tickets with \`create_task\`, choosing the parent based on what each milestone produces:
   - **Planning artefacts** (research, PRD, design, spec — anything the implementation team reads before building) → open as **sub-tasks of this planning ticket**: set \`parent_task_id\` to this task's id. Their outputs are required before the plan itself can be considered complete.
   - **Work tickets** (implementation, build, deploy, security review of built code, marketing launch — anything that *executes* the finished plan) → open as **top-level tickets**: leave \`parent_task_id\` unset. **Implementation must never be a child of this planning ticket** — not even when it feels like part of the same deliverable. Use \`blocked_by_task_ids\` for ordering instead. Deployment sits under the Architect (the DevOps Engineer's manager): hand the Architect the spec ticket and let them pre-file and gate the deploy ticket (\`blocked_by\` the QA and security reviews) inside their execution cluster, rather than creating it here. Sequence the **marketing launch after deployment** — the Marketing Lead drafts in parallel but holds publishing until the deploy ticket closes.
   For a typical 7-milestone plan: research / PRD / design / spec → sub-tasks (for UI-bearing software work the UI is figured out first, then the spec and implementation are planned against the approved design); alpha implementation / security review / marketing launch → top-level. Assign each ticket to the right agent — the assignment wakes them on their own ticket.
5. This planning ticket is the epic for the plan itself. The server will not let it move to \`done\` while any sub-task is open, so it stays open while research / PRD / design / spec execute. Once those sub-tasks reach a terminal status (\`done\` or \`cancelled\`) and the top-level work tickets have been created, move this task to \`done\`; the Coach reviews it after the post-mortem but it stays \`done\`. Trying to flip it to \`done\` early will fail with a "sub-task(s) still open" error.

Container provisioning for this project is in progress. Focus on planning while the environment comes up — implementation agents can start work as soon as their tickets are ready.`;

	const taskResult = await db.query(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier,
		                     title, description, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::task_status, $9::task_priority, $10::jsonb)
		 RETURNING *`,
		[
			input.teamId,
			projectId,
			input.captainMemberId,
			taskNumber,
			identifier,
			`Draft execution plan for "${projectName}"`,
			taskBody,
			TaskStatus.Backlog,
			TaskPriority.High,
			JSON.stringify(['planning']),
		],
	);
	return { planningTask: taskResult.rows[0] as Record<string, unknown> };
}

/**
 * Create a project together with its planning task (planning ticket first).
 * Callers that need another ticket (e.g. the CEO coherence review) to take the
 * first identifier should compose `createProject` + `createPlanningTask` instead.
 */
export async function createProjectWithPlanningTask(
	db: PGlite,
	input: CreateProjectWithPlanningInput,
): Promise<CreateProjectWithPlanningResult> {
	const { project, deferCaptainPlanningWake } = await createProject(db, input);
	const { planningTask } = await createPlanningTask(db, {
		teamId: input.teamId,
		project,
		captainMemberId: input.captainMemberId,
		name: input.name,
		description: input.description,
		initialProjectPlan: input.initialProjectPlan,
	});
	return { project, planningTask, deferCaptainPlanningWake };
}

export const TASK_PREFIX_SHAPE = /^[A-Z][A-Z0-9]{1,3}$/;

export type TaskPrefixResult =
	| { ok: true; prefix: string }
	| { ok: false; code: 'INVALID_REQUEST' | 'CONFLICT'; message: string; status: 400 | 409 };

export async function resolveProjectTaskPrefix(
	db: PGlite,
	teamId: string,
	provided: string | undefined,
	projectName: string,
): Promise<TaskPrefixResult> {
	if (provided?.trim()) {
		const candidate = provided.trim().toUpperCase();
		if (!TASK_PREFIX_SHAPE.test(candidate)) {
			return {
				ok: false,
				code: 'INVALID_REQUEST',
				message: 'task_prefix must be 2-4 uppercase alphanumeric characters starting with a letter',
				status: 400,
			};
		}
		const collision = await db.query(
			'SELECT 1 FROM projects WHERE team_id = $1 AND task_prefix = $2',
			[teamId, candidate],
		);
		if (collision.rows.length > 0) {
			return {
				ok: false,
				code: 'CONFLICT',
				message: `Task prefix '${candidate}' is already in use for this team`,
				status: 409,
			};
		}
		return { ok: true, prefix: candidate };
	}

	const base = toProjectTaskPrefix(projectName);
	const existing = await db.query<{ task_prefix: string }>(
		'SELECT task_prefix FROM projects WHERE team_id = $1 AND task_prefix LIKE $2',
		[teamId, `${base}%`],
	);
	const taken = new Set(existing.rows.map((r) => r.task_prefix));
	if (!taken.has(base)) return { ok: true, prefix: base };
	for (let n = 2; n < 1000; n++) {
		const candidate = `${base}${n}`;
		if (!TASK_PREFIX_SHAPE.test(candidate)) break;
		if (!taken.has(candidate)) return { ok: true, prefix: candidate };
	}
	return {
		ok: false,
		code: 'CONFLICT',
		message: `Unable to derive a unique task_prefix from '${projectName}'; supply one explicitly`,
		status: 409,
	};
}

type ResolveTemplateResult =
	| { ok: true; templateId: string | undefined }
	| { ok: false; code: 'INVALID_REQUEST' | 'NOT_FOUND'; message: string; status: 400 | 404 };

/**
 * Generates a `team_templates.name` that doesn't clash with an existing one by
 * appending " (2)", " (3)", … to the base. Mirrors `uniqueSlug` — each
 * snapshot of a source team mints a fresh, distinctly-named template.
 */
async function uniqueTemplateName(db: PGlite, base: string): Promise<string> {
	let candidate = base;
	let n = 2;
	while (
		(await db.query('SELECT 1 FROM team_templates WHERE name = $1', [candidate])).rows.length
	) {
		candidate = `${base} (${n})`;
		n++;
	}
	return candidate;
}

/**
 * Resolves the team-type template a new project's team is provisioned from.
 * A caller picks either an existing template (`templateId`) or an existing team
 * to clone (`sourceTeamId`); cloning snapshots that team into a fresh permanent
 * template (reusable from then on). With neither, defaults to the Blank template.
 */
export async function resolveCreationTemplate(
	db: PGlite,
	opts: { templateId?: string; sourceTeamId?: string; description?: string },
): Promise<ResolveTemplateResult> {
	const templateId = opts.templateId?.trim() || undefined;
	const sourceTeamId = opts.sourceTeamId?.trim() || undefined;

	if (templateId && sourceTeamId) {
		return {
			ok: false,
			code: 'INVALID_REQUEST',
			message: 'Provide either template_id or source_team_id, not both',
			status: 400,
		};
	}

	if (templateId) return { ok: true, templateId };

	if (sourceTeamId) {
		const team = await db.query<{ name: string; is_internal: boolean }>(
			`SELECT t.name,
			        EXISTS (SELECT 1 FROM projects p WHERE p.team_id = t.id AND p.is_internal = true) AS is_internal
			 FROM teams t WHERE t.id = $1`,
			[sourceTeamId],
		);
		const row = team.rows[0];
		if (!row) {
			return { ok: false, code: 'NOT_FOUND', message: 'Source team not found', status: 404 };
		}
		if (row.is_internal) {
			return {
				ok: false,
				code: 'INVALID_REQUEST',
				message: 'The HQ team cannot be used as a source team',
				status: 400,
			};
		}
		const name = await uniqueTemplateName(db, row.name);
		const snapshot = await snapshotTeamAsTemplate(db, sourceTeamId, {
			name,
			description: opts.description?.trim() || `Snapshot of the "${row.name}" team`,
		});
		return { ok: true, templateId: snapshot.template_id };
	}

	const blank = await db.query<{ id: string }>('SELECT id FROM team_templates WHERE name = $1', [
		'Blank',
	]);
	return { ok: true, templateId: blank.rows[0]?.id };
}

export interface CreateProjectWithTeamInput {
	name: string;
	description: string;
	/** Team-type template to provision the roster from; mutually exclusive with sourceTeamId. */
	templateId?: string;
	/** Existing team to clone (snapshotted into a fresh template); mutually exclusive with templateId. */
	sourceTeamId?: string;
	taskPrefix?: string;
	initialProjectPlan?: string | null;
	dockerBaseImage?: string;
	/** Added as the new team's admin member (any human admin who creates it). */
	creatorUserId?: string;
	/** Audit actor type for the project.created event. Defaults to 'admin'. */
	actorType?: AuditActorType;
	/** When set, the audit actor is resolved to this user's member in the new team. */
	actorUserId?: string;
	/** Explicit audit actor member id (e.g. the CEO when created via the MCP tool). */
	actorMemberId?: string | null;
	/**
	 * When set (the CEO's create_project path), the initial coherence/setup ticket
	 * is created UNASSIGNED and is NOT auto-woken — the CEO drafts its description
	 * with the concrete intake plan and then calls `start_team_setup` to begin the
	 * run. The direct `POST /api/projects` path leaves this false so coherence
	 * auto-runs as before.
	 */
	suppressCoherenceAutoStart?: boolean;
}

export type CreateProjectWithTeamResult =
	| {
			ok: true;
			project: Record<string, unknown>;
			planningTask: Record<string, unknown>;
			team: CreatedTeamRow;
			/** The initial coherence/setup ticket, or null when coherence review is skipped. */
			coherenceTask: { id: string; identifier: string } | null;
	  }
	| {
			ok: false;
			code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';
			message: string;
			status: 400 | 404 | 409 | 500;
	  };

/**
 * Create a project together with its dedicated team in one step — the single
 * canonical "create a project" sequence: resolve the team-type template, stand
 * up the team + roster, create the project, seed the CEO coherence-review ticket
 * (it takes the first identifier) ahead of the Captain's planning ticket (blocked
 * on coherence), wake the Captain, and provision the container in the background.
 *
 * Shared by the superuser "Create now" route (`POST /api/projects`) and the CEO's
 * `create_project` MCP tool, which the CEO calls once the admin approves a project
 * intake in-thread. `deps` is a `ContainerDeps` (a superset of `CreateTeamDeps`);
 * container provisioning is skipped when `opts.provisionContainer === false`.
 */
export async function createProjectWithTeam(
	deps: ContainerDeps,
	input: CreateProjectWithTeamInput,
	opts: { events?: DomainEventBus; provisionContainer?: boolean } = {},
): Promise<CreateProjectWithTeamResult> {
	const { db } = deps;
	const name = input.name.trim();
	const description = input.description.trim();

	// Validate the task-prefix shape up front so a bad prefix doesn't leave an
	// orphan team behind (a collision can't happen on a brand-new team).
	if (input.taskPrefix?.trim() && !TASK_PREFIX_SHAPE.test(input.taskPrefix.trim().toUpperCase())) {
		return {
			ok: false,
			code: 'INVALID_REQUEST',
			message: 'task_prefix must be 2-4 uppercase alphanumeric characters starting with a letter',
			status: 400,
		};
	}

	const templateResult = await resolveCreationTemplate(db, {
		templateId: input.templateId,
		sourceTeamId: input.sourceTeamId,
		description,
	});
	if (!templateResult.ok) return templateResult;

	const team = await createTeam(deps, {
		name,
		description,
		templateId: templateResult.templateId,
		creatorUserId: input.creatorUserId,
	});

	const prefixResult = await resolveProjectTaskPrefix(db, team.id, input.taskPrefix, name);
	if (!prefixResult.ok) return prefixResult;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status`,
		[team.id, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG],
	);
	const captainMemberId = captain.rows[0]?.id;
	if (!captainMemberId) {
		return { ok: false, code: 'INTERNAL', message: 'New team is missing its Captain', status: 500 };
	}

	let actorMemberId: string | null = input.actorMemberId ?? null;
	if (!actorMemberId && input.actorUserId) {
		const r = await db.query<{ id: string }>(
			`SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id
			 WHERE mu.user_id = $1 AND m.team_id = $2`,
			[input.actorUserId, team.id],
		);
		actorMemberId = r.rows[0]?.id ?? null;
	}

	const slug = await uniqueSlug(toSlug(name), async (s) => {
		const r = await db.query('SELECT 1 FROM projects WHERE slug = $1', [s]);
		return r.rows.length > 0;
	});

	const { project } = await createProject(db, {
		teamId: team.id,
		captainMemberId,
		name,
		slug,
		taskPrefix: prefixResult.prefix,
		description,
		initialProjectPlan: input.initialProjectPlan ?? null,
		dockerBaseImage: input.dockerBaseImage,
		events: opts.events,
		actorType: input.actorType ?? 'admin',
		actorMemberId,
	});

	// The CEO's initial coherence/setup pass is the project's first ticket and
	// blocks planning, so it's created before the planning task to take TO-1. On
	// the CEO's create_project path it is created unassigned and not auto-woken —
	// the CEO drafts it then kicks it off with `start_team_setup`.
	const coherenceTaskId = await enqueueTeamCoherenceReviewTask(db, team.id, 'initial', {
		autoStart: !input.suppressCoherenceAutoStart,
	});

	const { planningTask } = await createPlanningTask(db, {
		teamId: team.id,
		project,
		captainMemberId,
		name,
		description,
		initialProjectPlan: input.initialProjectPlan ?? null,
	});

	// Resolve the coherence ticket row once: its identifier is surfaced to the
	// caller (so the CEO can edit it on the create_project path) and the row is
	// broadcast so a pending, unassigned setup ticket is visible in the UI rather
	// than silently waiting (the auto-run path used to open it immediately).
	let coherenceTask: { id: string; identifier: string } | null = null;
	let coherenceRow: Record<string, unknown> | null = null;
	if (coherenceTaskId) {
		const r = await db.query<Record<string, unknown>>('SELECT * FROM tasks WHERE id = $1', [
			coherenceTaskId,
		]);
		if (r.rows[0]) {
			coherenceRow = r.rows[0];
			coherenceTask = { id: coherenceTaskId, identifier: r.rows[0].identifier as string };
		}
	}

	if (deps.wsManager) {
		broadcastRowChange(deps.wsManager, wsRoom.team(team.id), 'projects', 'INSERT', project);
		broadcastRowChange(deps.wsManager, wsRoom.team(team.id), 'tasks', 'INSERT', planningTask);
		if (coherenceRow) {
			broadcastRowChange(deps.wsManager, wsRoom.team(team.id), 'tasks', 'INSERT', coherenceRow);
		}
		// The new team's room above is one no shell has joined yet, so the rail
		// can't learn of the project from it. Signal the global project index so
		// every connected shell refetches and the project appears in the rail at
		// once — covers the dialog, the CEO's create_project, and other sessions.
		broadcastProjectsChanged(deps.wsManager);
	}

	if (coherenceTaskId) {
		await db.query(
			`INSERT INTO task_dependencies (task_id, blocked_by_task_id)
			 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			[planningTask.id, coherenceTaskId],
		);
	}

	// The Captain is woken unconditionally for its planning ticket (the
	// deferCaptainPlanningWake flag only applies to the instance bootstrap path,
	// which does not go through this service).
	trackBackground(
		createWakeup(db, captainMemberId, team.id, WakeupSource.Assignment, {
			task_id: planningTask.id as string,
		}).catch((e) => log.error('Failed to wake Captain for planning:', e)),
	);

	if (opts.provisionContainer !== false) {
		trackBackground(
			provisionContainer(deps, project as unknown as ProjectRow, team.slug).catch((e) =>
				log.error('Failed to provision container for new project:', e),
			),
		);
	}

	return { ok: true, project, planningTask, team, coherenceTask };
}

import type { PGlite } from '@electric-sql/pglite';
import { type AuditActorType, TaskPriority, TaskStatus } from '@hezo/shared';
import type { DomainEventBus } from '../events/bus';
import { withTransaction } from '../lib/sql';
import { allocateTaskIdentifier } from '../lib/task-identifier';

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
	initialPrd?: string | null;
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
 * Create the project row, its task counter, and seed docs (incl. any initial
 * PRD). The planning task is created separately by `createPlanningTask` so a
 * caller can slot other tickets (e.g. the CEO coherence review) ahead of it and
 * control identifier ordering. Emits the project.created audit event.
 */
export async function createProject(
	db: PGlite,
	input: CreateProjectWithPlanningInput,
): Promise<CreateProjectResult> {
	const projectName = input.name.trim();
	const projectDescription = input.description.trim();
	const initialPrd = input.initialPrd?.trim() || null;

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

		if (initialPrd) {
			await db.query(
				`INSERT INTO documents (project_id, team_id, type, slug, content)
				 VALUES ($1, $2, 'project_doc', 'initial-prd.md', $3)`,
				[project.id, input.teamId, initialPrd],
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
		initialPrd?: string | null;
	},
): Promise<{ planningTask: Record<string, unknown> }> {
	const projectName = input.name.trim();
	const projectDescription = input.description.trim();
	const initialPrd = input.initialPrd?.trim() || null;
	const projectId = input.project.id as string;

	const { number: taskNumber, identifier } = await allocateTaskIdentifier(db, projectId);

	const initialPrdNote = initialPrd
		? `\n\n> **Note:** The admin has provided an initial requirements document saved as \`initial-prd.md\` in this project's docs. Direct the Researcher and Product Lead to consult this document as a starting point for research and the formal PRD.`
		: '';

	const taskBody = `## Draft the execution plan for this new project

A new project has just been created. Please read the description below carefully and produce an execution plan.

### Project: ${projectName}

**Description**

${projectDescription}${initialPrdNote}

### Your task

1. Read the description above. If anything is ambiguous, post a clarifying comment on this task for the admin.
2. Use \`list_agents\` / \`get_agent_system_prompt\` to recall who is on the team.
3. Break the work into 3-8 top-level milestones. Write a short scope note for each.
4. Post the plan as a comment on this task. Then create the milestone tickets with \`create_task\`, choosing the parent based on what each milestone produces:
   - **Planning artefacts** (research, PRD, spec, design — anything the implementation team reads before building) → open as **sub-tasks of this planning ticket**: set \`parent_task_id\` to this task's id. Their outputs are required before the plan itself can be considered complete.
   - **Work tickets** (implementation, build, deploy, security review of built code, marketing launch — anything that *executes* the finished plan) → open as **top-level tickets**: leave \`parent_task_id\` unset. They run on their own clock; the plan is complete once they exist.
   For a typical 7-milestone plan: research / PRD / spec / design → sub-tasks; alpha implementation / security review / marketing launch → top-level. Assign each ticket to the right agent — the assignment wakes them on their own ticket.
5. This planning ticket is the epic for the plan itself. The server will not let it move to \`done\` while any sub-task is open, so it stays open while research / PRD / spec / design execute. Once those sub-tasks close and the top-level work tickets have been created, move this task to \`done\` and the Coach will close it after the post-mortem. Trying to flip it to \`done\` early will fail with a "sub-task(s) still open" error.

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
		initialPrd: input.initialPrd,
	});
	return { project, planningTask, deferCaptainPlanningWake };
}

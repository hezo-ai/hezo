import type { PGlite } from '@electric-sql/pglite';
import { IssuePriority, IssueStatus } from '@hezo/shared';
import { allocateIssueIdentifier } from '../lib/issue-identifier';

export interface CreateProjectWithPlanningInput {
	teamId: string;
	captainMemberId: string;
	name: string;
	slug: string;
	issuePrefix: string;
	description: string;
	dockerBaseImage?: string;
	initialPrd?: string | null;
}

export interface CreateProjectWithPlanningResult {
	project: Record<string, unknown>;
	planningIssue: Record<string, unknown>;
}

export async function createProjectWithPlanningIssue(
	db: PGlite,
	input: CreateProjectWithPlanningInput,
): Promise<CreateProjectWithPlanningResult> {
	const projectName = input.name.trim();
	const projectDescription = input.description.trim();
	const initialPrd = input.initialPrd?.trim() || null;

	await db.query('BEGIN');
	try {
		const projectResult = await db.query(
			`INSERT INTO projects (team_id, name, slug, issue_prefix, description, docker_base_image)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 RETURNING *`,
			[
				input.teamId,
				projectName,
				input.slug,
				input.issuePrefix,
				projectDescription,
				input.dockerBaseImage ?? 'hezo/agent-base:latest',
			],
		);
		const project = projectResult.rows[0] as Record<string, unknown>;

		await db.query('INSERT INTO project_issue_counters (project_id, next_number) VALUES ($1, 1)', [
			project.id,
		]);

		if (initialPrd) {
			await db.query(
				`INSERT INTO documents (project_id, team_id, type, slug, content)
				 VALUES ($1, $2, 'project_doc', 'initial-prd.md', $3)`,
				[project.id, input.teamId, initialPrd],
			);
		}

		const { number: issueNumber, identifier } = await allocateIssueIdentifier(
			db,
			project.id as string,
		);

		const initialPrdNote = initialPrd
			? `\n\n> **Note:** The board has provided an initial requirements document saved as \`initial-prd.md\` in this project's docs. Direct the Researcher and Product Lead to consult this document as a starting point for research and the formal PRD.`
			: '';

		const issueBody = `## Draft the execution plan for this new project

A new project has just been created. Please read the description below carefully and produce an execution plan.

### Project: ${projectName}

**Description**

${projectDescription}${initialPrdNote}

### Your task

1. Read the description above. If anything is ambiguous, post a clarifying comment on this issue for the board.
2. Use \`list_agents\` / \`get_agent_system_prompt\` to recall who is on the team.
3. Break the work into 3-8 top-level milestones. Write a short scope note for each.
4. Post the plan as a comment on this issue. Then create the milestone tickets with \`create_issue\`, choosing the parent based on what each milestone produces:
   - **Planning artefacts** (research, PRD, spec, design — anything the implementation team reads before building) → open as **sub-issues of this planning ticket**: set \`parent_issue_id\` to this issue's id. Their outputs are required before the plan itself can be considered complete.
   - **Work tickets** (implementation, build, deploy, security review of built code, marketing launch — anything that *executes* the finished plan) → open as **top-level tickets**: leave \`parent_issue_id\` unset. They run on their own clock; the plan is complete once they exist.
   For a typical 7-milestone plan: research / PRD / spec / design → sub-issues; alpha implementation / security review / marketing launch → top-level. Assign each ticket to the right agent — the assignment wakes them on their own ticket.
5. This planning ticket is the epic for the plan itself. The server will not let it move to \`done\` while any sub-issue is open, so it stays open while research / PRD / spec / design execute. Once those sub-issues close and the top-level work tickets have been created, move this issue to \`done\` and the Coach will close it after the post-mortem. Trying to flip it to \`done\` early will fail with a "sub-issue(s) still open" error.

Container provisioning for this project is in progress. Focus on planning while the environment comes up — implementation agents can start work as soon as their tickets are ready.`;

		const issueResult = await db.query(
			`INSERT INTO issues (team_id, project_id, assignee_id, number, identifier,
			                     title, description, status, priority, labels)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::issue_status, $9::issue_priority, $10::jsonb)
			 RETURNING *`,
			[
				input.teamId,
				project.id,
				input.captainMemberId,
				issueNumber,
				identifier,
				`Draft execution plan for "${projectName}"`,
				issueBody,
				IssueStatus.Backlog,
				IssuePriority.High,
				JSON.stringify(['planning']),
			],
		);
		const planningIssue = issueResult.rows[0] as Record<string, unknown>;

		await db.query('COMMIT');
		return { project, planningIssue };
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}
}

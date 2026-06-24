import type { PGlite } from '@electric-sql/pglite';
import { TaskPriority, TaskStatus, TERMINAL_TASK_STATUSES, WakeupSource } from '@hezo/shared';
import { allocateTaskIdentifier } from '../lib/task-identifier';
import { logger } from '../logger';
import { loadTeamCoordinationContext, type TeamCoordinationContext } from './internal-intake';
import { createWakeup } from './wakeup';

const log = logger.child('description-tasks');

const COHERENCE_LABEL = 'team-coherence-review';

export type TeamCoherenceReviewReason =
	| 'initial'
	| 'template_applied'
	| 'agent_hired'
	| 'agent_removed'
	| 'reports_to_changed'
	| 'prompt_updated'
	| 'role_updated'
	| 'summary_updated'
	| 'enabled_changed';

/** Resolves the CEO + the team's own project — coherence/setup live in that project. */
async function loadTeamContext(
	db: PGlite,
	teamId: string,
): Promise<TeamCoordinationContext | null> {
	return loadTeamCoordinationContext(db, teamId);
}

async function findOpenLabeledTask(
	db: PGlite,
	teamId: string,
	label: string,
): Promise<string | null> {
	const placeholders = TERMINAL_TASK_STATUSES.map((_, i) => `$${i + 3}::task_status`).join(', ');
	const result = await db.query<{ id: string }>(
		`SELECT id FROM tasks
		 WHERE team_id = $1
		   AND labels @> $2::jsonb
		   AND status NOT IN (${placeholders})
		 LIMIT 1`,
		[teamId, JSON.stringify([label]), ...TERMINAL_TASK_STATUSES],
	);
	return result.rows[0]?.id ?? null;
}

async function createLabeledInternalTask(
	db: PGlite,
	ctx: TeamCoordinationContext,
	title: string,
	body: string,
	label: string,
	priority: TaskPriority,
	autoStart = true,
): Promise<string | null> {
	const { number: taskNumber, identifier } = await allocateTaskIdentifier(db, ctx.teamProjectId);

	const insertResult = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier,
		                     title, description, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::task_status, $9::task_priority, $10::jsonb)
		 RETURNING id`,
		[
			ctx.teamId,
			ctx.teamProjectId,
			autoStart ? ctx.ceoMemberId : null,
			taskNumber,
			identifier,
			title,
			body,
			TaskStatus.Backlog,
			priority,
			JSON.stringify(['internal', label]),
		],
	);

	const taskId = insertResult.rows[0].id;

	// When not auto-starting (a CEO-created project), the ticket is left
	// unassigned and no wakeup fires — the CEO drafts the concrete setup plan into
	// it and then calls `start_team_setup` to assign it to itself and begin the run.
	if (autoStart) {
		try {
			await createWakeup(db, ctx.ceoMemberId, ctx.teamId, WakeupSource.Assignment, {
				task_id: taskId,
			});
		} catch (e) {
			log.error(`Failed to wake CEO for ${label}:`, e);
		}
	}

	return taskId;
}

function buildTeamCoherenceReviewBody(
	reason: TeamCoherenceReviewReason,
	teamSlug: string,
	autoStart = true,
): string {
	const draftBanner = autoStart
		? ''
		: `> **Setup plan — fill this in before you start.**
> You created this project from an intake conversation, so this setup ticket has **not** started yet and is currently unassigned. Replace the generic audit below with the concrete setup you settled with the operator: the specific roles to hire (and why), any system-prompt rewrites, and the reporting structure. Edit this description with \`update_task\`. When it reflects the agreed plan, call \`start_team_setup(project="${teamSlug}")\` to assign this ticket to yourself and begin the run. Until you do, the Captain's planning ticket stays blocked on it.

`;
	return `${draftBanner}## Team coherence review

The **${teamSlug}** project-team changed (reason: ${reason}). Audit its roster, then rewrite the descriptive blobs that other agents read so they stay accurate. Use \`team_id\` = \`${teamSlug}\` for the tool calls below.

**Steps**

1. Call \`list_agents(team_id)\` to enumerate every enabled agent and their \`reports_to\` relationships.
2. For each agent, call \`get_agent_system_prompt(team_id, agent_id=...)\` to read its current system prompt.
3. Audit for problems:
   - **Orphans** — agents with no manager who should report to someone (the Captain legitimately reports to the CEO in HQ, and the Coach to the admin — don't flag either as an orphan).
   - **Cycles** — reports_to chains that loop.
   - **Stale prompts** — system prompts that describe a manager, peer, or report that no longer matches the actual team structure.
   - **Coverage gaps** — responsibilities the team is expected to own but no agent describes itself as covering.
   - **Conflicts** — two agents claiming the same responsibility with no division of work.
4. Reconcile what you can:
   - Use \`update_agent_system_prompt(agent_id, content)\` to rewrite a prompt so it matches the current team structure.
   - For changes you cannot make through MCP tools (re-parenting an agent, removing an agent, hiring a new role), post a single summary comment on this ticket explaining what should change and request admin confirmation. Do NOT block on the comment — finish steps 5 and 6 with the current roster.
5. **Rewrite the descriptive blobs.** For every enabled agent:
   - \`set_agent_summary(agent_id, summary="...")\` — distill the agent's prompt into a single plain-prose paragraph (≤5 lines, third person, no bullets, no greetings) describing what the agent does and how it works.
   - \`set_agent_team_context(agent_id, content="...")\` — write a relationships narrative addressed to that agent ("you"), up to ~30 lines, covering its manager (and how to escalate), direct reports (and how to delegate to each), peers (and typical handoffs), indirect reports / agents two+ levels away (and the correct routing path), and any humans on the admin (and when to involve them).
   - This blob is injected into the agent's own system prompt at the start of every run, so it doesn't need to derive its place in the org chart from scratch.
6. \`set_team_summary(summary="...")\` — synthesise a team-level summary (≤20 lines, plain prose, may span paragraphs) covering reporting structure, handoffs, and escalation paths.
7. Move this task to **done** once the audit and rewrites are complete.`;
}

export async function enqueueTeamCoherenceReviewTask(
	db: PGlite,
	teamId: string,
	reason: TeamCoherenceReviewReason,
	opts: { autoStart?: boolean } = {},
): Promise<string | null> {
	if (process.env.HEZO_E2E_SKIP_COHERENCE_REVIEW) return null;
	const ctx = await loadTeamContext(db, teamId);
	if (!ctx) return null;

	const existing = await findOpenLabeledTask(db, teamId, COHERENCE_LABEL);
	if (existing) {
		log.debug(`Skipping duplicate team coherence review; open task ${existing}`);
		return existing;
	}

	// Reactive reviews (hire, template-apply, prompt/summary changes) auto-start by
	// default. Only the CEO's create_project path passes autoStart=false, leaving the
	// ticket unassigned for the CEO to draft then kick off via `start_team_setup`.
	const autoStart = opts.autoStart ?? true;
	const teamSlug = await db.query<{ slug: string }>('SELECT slug FROM teams WHERE id = $1', [
		teamId,
	]);
	const body = buildTeamCoherenceReviewBody(reason, teamSlug.rows[0]?.slug ?? teamId, autoStart);
	return createLabeledInternalTask(
		db,
		ctx,
		'Review team coherence after roster change',
		body,
		COHERENCE_LABEL,
		TaskPriority.High,
		autoStart,
	);
}

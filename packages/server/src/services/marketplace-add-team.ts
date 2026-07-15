import type { MarketplaceTeamDef } from '@hezo/shared';
import { TaskPriority, TaskStatus, WakeupSource } from '@hezo/shared';
import type { Db } from '../db/database';
import { allocateTaskIdentifier } from '../lib/task-identifier';
import { logger } from '../logger';
import { loadTeamCoordinationContext } from './internal-intake';
import { createWakeup } from './wakeup';

const log = logger.child('marketplace-add-team');

const ADD_TEAM_LABEL = 'add-marketplace-team';

export interface AddMarketplaceTeamTaskResult {
	task_id: string;
	task_identifier: string;
}

function buildAddTeamBody(projectSlug: string, teamDef: MarketplaceTeamDef): string {
	return `## Add the "${teamDef.name}" team (v${teamDef.version})

The admin chose to add the **${teamDef.name}** marketplace team (${teamDef.roster.length} role${
		teamDef.roster.length === 1 ? '' : 's'
	}) to this project. The admin has already approved this — do NOT file hire proposals. Complete it in this one task. **First work out whether this is a fresh ADD or a version UPDATE**, then act accordingly:

1. **Assess the current roster.** Call \`list_agents(project="${projectSlug}")\`. Compare its roles to the marketplace team's roles — fetch those with \`get_marketplace_team(slug="${teamDef.slug}")\` (returns each role's title, reporting line, and current system prompt, plus the version + changelog).
   - **Version update** — this project already has some/all of these roles (it was created from this same team, or an earlier version of it). This is NOT a duplicate add: you are refreshing the existing roles to the newer system prompts. Do NOT create parallel copies.
   - **Fresh add** — the team has none (or only some) of these roles; the new ones are added alongside the existing roster.
2. **Apply the change.**
   - To add missing roles: \`apply_marketplace_team(project="${projectSlug}", slug="${teamDef.slug}")\` — it adds any roles the team lacks and skips the ones it already has.
   - To bring already-present roles up to this version: if those roles are unmodified (still the stock prompts from a previous import), \`apply_marketplace_team(project="${projectSlug}", slug="${teamDef.slug}", refresh_existing=true)\` refreshes their descriptions + system prompts in place. If a role has been customised for this project, do NOT blindly overwrite it — compare its current prompt (\`get_agent_system_prompt\`) with the new one from \`get_marketplace_team\` and fold the meaningful updates in with \`update_agent_system_prompt\`, preserving the local customisations.
3. **Reconcile the resulting roster.** Call \`list_agents\` again and integrate:
   - Where a role overlaps another, divide the work and rewrite the affected agents' \`update_agent_system_prompt\` / \`set_agent_summary\` / \`set_agent_team_context\` so each names the correct manager, peers, and reports for the *combined* team.
   - Fix reporting lines with \`set_agent_reports_to\`.
   - Ensure every producing role's output is verified by someone other than its author.
   - Call \`set_team_summary\` to describe the combined team.
4. Move this task to **done** once the roster is added/updated and reconciled.`;
}

/**
 * Kicks off a single CEO-owned task in the given team's project that adds a
 * marketplace team's roster (via the `apply_marketplace_team` tool — auto-hire, no
 * approval) and reconciles it with the existing roster, all in one run. Returns
 * the created task's id/identifier, or null when the team has no CEO/project
 * (e.g. HQ). The admin already opted in by adding the team, so no approval gate.
 */
export async function enqueueAddMarketplaceTeamTask(
	db: Db,
	teamId: string,
	teamDef: MarketplaceTeamDef,
): Promise<AddMarketplaceTeamTaskResult | null> {
	const ctx = await loadTeamCoordinationContext(db, teamId);
	if (!ctx) return null;

	const projectSlugRow = await db.query<{ slug: string }>(
		'SELECT slug FROM projects WHERE id = $1',
		[ctx.teamProjectId],
	);
	const projectSlug = projectSlugRow.rows[0]?.slug;
	if (!projectSlug) return null;

	const { number, identifier } = await allocateTaskIdentifier(db, ctx.teamProjectId);
	const insert = await db.query<{ id: string }>(
		`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier,
		                    title, description, status, priority, labels)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::task_status, $9::task_priority, $10::jsonb)
		 RETURNING id`,
		[
			ctx.teamId,
			ctx.teamProjectId,
			ctx.ceoMemberId,
			number,
			identifier,
			`Add the "${teamDef.name}" team to this project`,
			buildAddTeamBody(projectSlug, teamDef),
			TaskStatus.Backlog,
			TaskPriority.High,
			JSON.stringify(['internal', ADD_TEAM_LABEL]),
		],
	);
	const taskId = insert.rows[0].id;

	try {
		await createWakeup(db, ctx.ceoMemberId, ctx.teamId, WakeupSource.Assignment, {
			task_id: taskId,
		});
	} catch (e) {
		log.error('Failed to wake CEO for add-marketplace-team task:', e);
	}

	return { task_id: taskId, task_identifier: identifier };
}

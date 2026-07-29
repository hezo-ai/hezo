import type { MarketplaceRosterAgent, MarketplaceTeamDef } from '@hezo/shared';
import { TaskPriority, TaskStatus, WakeupSource } from '@hezo/shared';
import type { Db } from '../db/database';
import { allocateTaskIdentifier } from '../lib/task-identifier';
import { logger } from '../logger';
import { loadTeamCoordinationContext } from './internal-intake';
import { createWakeup } from './wakeup';

const log = logger.child('marketplace-add-team');

const ADD_TEAM_LABEL = 'add-marketplace-team';
const ADD_ROLES_LABEL = 'add-marketplace-roles';

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
 * Body for adding a SUBSET of a team's roster. Deliberately not a variant of
 * `buildAddTeamBody`: the two are different jobs. Taking a whole team is mostly
 * mechanical (add, or refresh on a version update); taking three roles out of it
 * means their prompts reference teammates that were left behind, so fitting them to
 * the existing roster is the work, and declining is a legitimate outcome.
 */
function buildAddRolesBody(
	projectSlug: string,
	teamDef: MarketplaceTeamDef,
	roles: MarketplaceRosterAgent[],
): string {
	const list = roles
		.map((r) => `   - **${r.title}** (\`${r.slug}\`) - ${r.role_description}`)
		.join('\n');
	const calls = roles
		.map(
			(r) =>
				`\`apply_marketplace_agent(project="${projectSlug}", slug="${teamDef.slug}", role="${r.slug}")\``,
		)
		.join(', ');
	const noun = roles.length === 1 ? 'role' : 'roles';

	return `## Add ${roles.length} ${noun} from the ${teamDef.name} team (v${teamDef.version})

The admin chose **specific ${noun}** from the **${teamDef.name}** marketplace team rather than the whole roster:

${list}

They have already approved the hire, so do NOT file hire proposals. But these ${noun} are being lifted out of a roster they were written for, and the rest of that team is **not** coming with them, so they do not slot in as-is. Fitting them to this project is the work.

1. **Read both sides.** Call \`get_marketplace_team(slug="${teamDef.slug}")\` and read the chosen ${noun} in full - \`title\`, \`role_description\`, \`summary\`, \`team_context\`, \`system_prompt\` - noting which teammates, hand-offs and reporting lines they assume. Then \`list_agents(project="${projectSlug}")\` for the roster they are joining.

2. **Decide whether each one fits - before you add it.** Post a comment with an active \`@admin\` and stop when:
   - an existing agent already covers that responsibility (adding a second one splits ownership);
   - the role's way of working depends on teammates this project does not have, and dropping those steps would change what the role actually is;
   - there is no sensible manager for it here.

   State the specific question and what you would do either way. You will be re-woken when they reply. Do not guess a role into the team. If some of the chosen ${noun} are clear and others are not, add the clear ones and ask about the rest.

3. **Add them.** ${calls}. Each call provisions exactly one role and leaves the rest of the roster - including this project's Captain - untouched. A role the team already has is reported as \`skipped\`, not duplicated. When a role's own manager is not on this team, the reporting line is wired to the Captain as a placeholder and \`reports_to_fell_back\` comes back true - that is for you to fix in step 4, not a decision.

4. **Fit them to this team.** Mandatory - a role added and left unreconciled will @-mention agents that do not exist and hand work to nobody.
   - Rewrite each new agent's \`system_prompt\` (\`update_agent_system_prompt\`) and \`team_context\` (\`set_agent_team_context\`) so every teammate, manager and hand-off they name is an agent that actually exists here. Keep every required substitution variable - \`{{team_name}}\`, \`{{reports_to}}\`, \`{{skills_context}}\`, \`{{project_docs_context}}\`, \`{{team_preferences_context}}\` - or the update is rejected. Where the home team split a workflow across roles this project does not have, fold the parts these ${noun} must still own into their prompts rather than leaving dangling references.
   - Set each one's real manager with \`set_agent_reports_to\`.
   - Write each one's \`set_agent_summary\`.
   - Update the \`team_context\` of the existing agents whose work now flows through them, so each hand-off is described from both sides.
   - Make sure every new role's output is verified by someone other than its author, and that anything they now take over is not still claimed by another agent's prompt.
   - Call \`set_team_summary\` to describe the team with the new ${noun} in it.

5. Move this task to **done** once the ${noun} are added and the roster reads coherently.`;
}

async function enqueueCeoTask(
	db: Db,
	teamId: string,
	title: string,
	buildBody: (projectSlug: string) => string,
	label: string,
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
			title,
			buildBody(projectSlug),
			TaskStatus.Backlog,
			TaskPriority.High,
			JSON.stringify(['internal', label]),
		],
	);
	const taskId = insert.rows[0].id;

	try {
		await createWakeup(db, ctx.ceoMemberId, ctx.teamId, WakeupSource.Assignment, {
			task_id: taskId,
		});
	} catch (e) {
		log.error(`Failed to wake CEO for ${label} task:`, e);
	}

	return { task_id: taskId, task_identifier: identifier };
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
	return enqueueCeoTask(
		db,
		teamId,
		`Add the "${teamDef.name}" team to this project`,
		(projectSlug) => buildAddTeamBody(projectSlug, teamDef),
		ADD_TEAM_LABEL,
	);
}

/**
 * Same as `enqueueAddMarketplaceTeamTask` but for a chosen SUBSET of the roster —
 * the CEO adds each role with `apply_marketplace_agent` and fits it to the existing
 * team, and is explicitly licensed to stop and ask `@admin` when a role does not
 * obviously belong. `roles` must be non-empty and drawn from the def's roster (the
 * caller validates that, which is also what rejects the Captain: it is never in
 * `roster`).
 */
export async function enqueueAddMarketplaceRolesTask(
	db: Db,
	teamId: string,
	teamDef: MarketplaceTeamDef,
	roles: MarketplaceRosterAgent[],
): Promise<AddMarketplaceTeamTaskResult | null> {
	const title =
		roles.length === 1
			? `Add the "${roles[0].title}" role from the ${teamDef.name} team`
			: `Add ${roles.length} roles from the ${teamDef.name} team`;
	return enqueueCeoTask(
		db,
		teamId,
		title,
		(projectSlug) => buildAddRolesBody(projectSlug, teamDef, roles),
		ADD_ROLES_LABEL,
	);
}

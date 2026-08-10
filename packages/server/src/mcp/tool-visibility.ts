/**
 * Which tools a given caller sees in `tools/list`.
 *
 * Every authenticated caller used to receive the whole registry, so a worker
 * agent scoped to one project carried `create_team`, the connector and
 * credential surface, and every Captain-only prompt editor - roughly 32k tokens
 * of schema resident in its context on every turn, much of it for tools its own
 * handler would refuse.
 *
 * **This is the hiding leg, never the enforcement leg.** Every gate in
 * `tools.ts` still runs on `tools/call`; nothing here is load-bearing for
 * authorization. That split matters in one direction specifically: a filter bug
 * must never become an authorization bug, so the audiences below are allowed to
 * be *coarser* than the handler's own check but never narrower. Where a handler
 * scopes by team as well as role, the audience keeps only the role half - a tool
 * shown to someone who cannot call it costs a wasted call and a clear error,
 * whereas a tool hidden from someone who could call it is a defect with no
 * feedback at all.
 *
 * `SKILL.md` and `docs/reference/mcp-api.md` keep documenting the whole
 * registry: they are unauthenticated and build-time surfaces respectively, and
 * an agent reading either should still learn a tool exists even where this run
 * will not show it.
 */

import { AuthType, CAPTAIN_AGENT_SLUG, CEO_AGENT_SLUG, DEFAULT_TEAM_ID } from '@hezo/shared';
import type { Db } from '../db/database';
import type { AuthInfo } from '../lib/types';

/**
 * The caller classes a tool can be restricted to, named for the gate its handler
 * actually enforces. Absence from {@link TOOL_AUDIENCE} means `everyone`, which
 * is correct for the ~60 tools gated only by project scope.
 */
export type ToolAudience =
	/** `Admin` with `isSuperuser`. Deliberately excludes the API key, which carries
	 *  `isSuperuser: true` but is rejected by `requireSuperuser`-shaped checks. */
	| 'admin_superuser'
	/** Any agent principal. */
	| 'agent'
	/** An agent inside a heartbeat run - excludes the CEO chat session, whose
	 *  `runId` is null. */
	| 'agent_run'
	/** An agent or a board user, but not an API key. */
	| 'agent_or_admin'
	/** The CEO agent. */
	| 'ceo'
	/** The CEO agent, but only agents are constrained - the handler lets an admin
	 *  or an API key straight through. */
	| 'ceo_if_agent'
	/** A team Captain. */
	| 'captain'
	/** A team Captain or the CEO. */
	| 'captain_or_ceo'
	/** A Captain, or an HQ agent (CEO/Coach) acting in the team. Covers both
	 *  `canCoordinateTeam` and its `|| isHqInstanceAgent` variant: the two differ
	 *  only in team scoping, which this layer deliberately does not model. */
	| 'coordinator';

/**
 * The restricted tools, and nothing else. Mirrors `MCP_WRITE_TOOLS`: a name set
 * consulted at registration rather than an argument threaded through 81 call
 * sites.
 *
 * Each entry was read off the handler's own check, not from the `auth:` prose in
 * `TOOL_DOC_META` - that prose is documentation and is wrong in several places
 * (it claims a gate for `list_marketplace_teams` and `get_marketplace_team`
 * whose handlers take no `auth` at all, and "Captain only" for
 * `update_goal_progress` / `update_project_progress`, which check only for an
 * agent in a run).
 */
export const TOOL_AUDIENCE: Readonly<Record<string, ToolAudience>> = {
	// Superuser board user only; the API key is rejected.
	create_team: 'admin_superuser',

	// An agent, inside a run.
	report_no_work: 'agent_run',
	update_goal_progress: 'agent_run',
	update_project_progress: 'agent_run',
	update_comment: 'agent_run',

	// An agent, editing its own memory.
	update_chat_memory: 'agent',

	// Same-team agent or board user; the API key is excluded.
	get_agent_system_prompt: 'agent_or_admin',
	get_agent_system_prompts: 'agent_or_admin',
	set_agent_summary: 'agent_or_admin',
	set_agent_summaries: 'agent_or_admin',
	get_agent_team_context: 'agent_or_admin',
	get_agent_team_contexts: 'agent_or_admin',

	// CEO only.
	create_project: 'ceo',
	start_team_setup: 'ceo',

	// CEO, but the check fires only for agents.
	apply_marketplace_team: 'ceo_if_agent',
	apply_marketplace_agent: 'ceo_if_agent',

	// Captain only.
	update_hire_proposal: 'captain',

	// Captain or CEO.
	suggest_goal: 'captain_or_ceo',
	create_hire_proposal: 'captain_or_ceo',

	// Captain, or an HQ agent acting in the team.
	set_agent_name: 'coordinator',
	generate_agent_avatar: 'coordinator',
	set_team_summary: 'coordinator',
	set_agent_team_context: 'coordinator',
	set_agent_team_contexts: 'coordinator',
	set_agent_reports_to: 'coordinator',
	set_agent_status: 'coordinator',
	update_agent_system_prompt: 'coordinator',
	update_agent_system_prompts: 'coordinator',
	update_project_custom_prompt: 'coordinator',
};

/**
 * The role facts an audience decision needs that `AuthInfo` does not carry.
 *
 * `AuthInfo` has `memberId`/`teamId`/`projectId` but no slug and no role, so
 * every role-shaped gate in `tools.ts` reads them from the database. One query
 * per `tools/list` answers all of them at once, and `tools/list` runs once per
 * session rather than per request.
 */
interface RoleFacts {
	slug: string | null;
	isHqAgent: boolean;
}

async function loadRoleFacts(db: Db, auth: AuthInfo): Promise<RoleFacts> {
	if (auth.type !== AuthType.Agent) return { slug: null, isHqAgent: false };
	const r = await db.query<{ slug: string | null; team_id: string }>(
		`SELECT ma.slug, m.team_id
		 FROM members m
		 LEFT JOIN member_agents ma ON ma.id = m.id
		 WHERE m.id = $1`,
		[auth.memberId],
	);
	const row = r.rows[0];
	return { slug: row?.slug ?? null, isHqAgent: row?.team_id === DEFAULT_TEAM_ID };
}

/**
 * One predicate per audience, so an added audience is a compile error rather
 * than a silently-permissive default.
 */
const AUDIENCE_PREDICATES: Record<ToolAudience, (auth: AuthInfo, role: RoleFacts) => boolean> = {
	admin_superuser: (auth) => auth.type === AuthType.Admin && auth.isSuperuser,
	agent: (auth) => auth.type === AuthType.Agent,
	agent_run: (auth) => auth.type === AuthType.Agent && auth.runId !== null,
	agent_or_admin: (auth) => auth.type === AuthType.Agent || auth.type === AuthType.Admin,
	ceo: (auth, role) => auth.type === AuthType.Agent && role.slug === CEO_AGENT_SLUG,
	ceo_if_agent: (auth, role) => auth.type !== AuthType.Agent || role.slug === CEO_AGENT_SLUG,
	captain: (auth, role) => auth.type === AuthType.Agent && role.slug === CAPTAIN_AGENT_SLUG,
	captain_or_ceo: (auth, role) =>
		auth.type === AuthType.Agent &&
		(role.slug === CAPTAIN_AGENT_SLUG || role.slug === CEO_AGENT_SLUG),
	coordinator: (auth, role) =>
		auth.type === AuthType.Agent && (role.isHqAgent || role.slug === CAPTAIN_AGENT_SLUG),
};

/** A tool entry as it travels through `tools/list`. */
interface ListedTool {
	name: string;
	inputSchema?: Record<string, unknown>;
	[key: string]: unknown;
}

/**
 * `$schema` is emitted once per tool by the JSON Schema converter and is inert
 * for every model that reads the list - roughly 4 KB of the payload spent
 * declaring a dialect nobody dispatches on.
 */
function withoutInertSchemaKeys(tool: ListedTool): ListedTool {
	const schema = tool.inputSchema;
	if (!schema || !('$schema' in schema)) return tool;
	const { $schema: _dropped, ...rest } = schema;
	return { ...tool, inputSchema: rest };
}

/**
 * The tool list for one caller: the tools its principal could actually call,
 * with the inert schema keys stripped.
 *
 * Onboarding tools are never in the registry, so they are unaffected.
 */
export async function projectToolsForCaller<T extends ListedTool>(
	db: Db,
	auth: AuthInfo,
	tools: readonly T[],
): Promise<ListedTool[]> {
	const restricted = tools.some((t) => TOOL_AUDIENCE[t.name] !== undefined);
	const role = restricted ? await loadRoleFacts(db, auth) : { slug: null, isHqAgent: false };
	const out: ListedTool[] = [];
	for (const t of tools) {
		const audience = TOOL_AUDIENCE[t.name];
		if (audience && !AUDIENCE_PREDICATES[audience](auth, role)) continue;
		out.push(withoutInertSchemaKeys(t));
	}
	return out;
}

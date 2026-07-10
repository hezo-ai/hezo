import { HEZO_DOCS_URL } from '@hezo/shared';

/**
 * Generates the user-facing **MCP API reference** (`docs/reference/mcp-api.md`)
 * from the live MCP tool registry. The tool list, descriptions, and parameter
 * tables are derived 100% from code (the registered Zod schemas → JSON Schema),
 * so they cannot drift. Each tool's return shape and authorization note are not
 * formally typed anywhere — they live in handler logic — so they are authored in
 * `TOOL_DOC_META` below; `mcp-reference.test.ts` asserts that table covers
 * exactly the registered tools, so a new tool cannot ship undocumented.
 *
 * The page is written to disk by `scripts/build-mcp-reference.ts` (run as part of
 * `bun run build:docs`) and committed, because the public docs site renders the
 * committed `docs/**​/*.md` files directly.
 */

/** A tool as the generator consumes it (a `ToolDef`, or an onboarding tool). */
export interface McpReferenceTool {
	name: string;
	description: string;
	/** JSON Schema of the input parameters (object schema with properties/required). */
	schema: Record<string, unknown>;
	/** True for data-persisting tools. */
	write?: boolean;
}

interface ToolDocMeta {
	/** Section heading the tool is grouped under (must be in MCP_REFERENCE_CATEGORY_ORDER). */
	category: string;
	/** Prose description of the tool's return shape. */
	returns: string;
	/** Optional role/scope note when the tool restricts callers beyond same-team access. */
	auth?: string;
}

/** Section order on the page. Every TOOL_DOC_META.category must appear here. */
export const MCP_REFERENCE_CATEGORY_ORDER: readonly string[] = [
	'Teams',
	'Projects',
	'Tasks',
	'Goals',
	'Comments & reactions',
	'Agents & hiring',
	'Agent prompts & context',
	'Approvals',
	'Skills & search',
	'Credentials & connectors',
	'MCP connections',
	'Project docs & assets',
	'Costs',
	'Onboarding',
];

/**
 * Per-tool return shape + authorization note. Keyed by tool name; must contain
 * exactly the registered authenticated tools plus the onboarding tools (enforced
 * by `mcp-reference.test.ts`). The default authorization — caller must have
 * access to the resolved project's team — is documented once under "Conventions",
 * so `auth` is set only when a tool restricts callers further.
 */
export const TOOL_DOC_META: Record<string, ToolDocMeta> = {
	// Teams
	list_teams: {
		category: 'Teams',
		returns:
			'An array of team rows (`id`, `name`, `slug`, `description`, …). An API key, the instance CEO, and an agent run with cross-team scope get every team; an ordinary agent run gets only its own team; a board user gets the teams they belong to (all teams for a superuser).',
	},
	get_team: {
		category: 'Teams',
		returns: 'The single team row backing the resolved project, or `null` if none.',
	},
	create_team: {
		category: 'Teams',
		returns: 'The created team row.',
		auth: 'Superuser only.',
	},

	// Projects
	list_projects: {
		category: 'Projects',
		returns:
			'An array of project rows (`id`, `team_id`, `name`, `slug`, `task_prefix`, `description`, `is_internal`, `created_at`, `updated_at`). With `excerpt_chars`, `description` is truncated and `description_truncated`/`description_length` companions are added.',
		auth: 'An API key, CEO cross-team access, or a superuser returns every project; a board user gets the projects on their teams; an agent run gets its own project.',
	},
	create_project: {
		category: 'Projects',
		returns:
			'The new project row plus `team_slug`, `planning_task_id`, `planning_task_identifier`, and the initial coherence/setup ticket (`coherence_task_id`, `coherence_task_identifier`). The coherence ticket is created unassigned and does NOT auto-run on this path — draft its description then call `start_team_setup`. Returns `{ error }` if validation fails.',
		auth: 'CEO only — call after the admin has explicitly approved the scope and team type in intake.',
	},
	start_team_setup: {
		category: 'Projects',
		returns:
			'`{ started: true, task_id, task_identifier }` after assigning the project’s open coherence/setup ticket to the CEO and waking them to run it. Returns `{ error }` if there is no open setup ticket for the project or a run is already active on it.',
		auth: 'CEO only — for a project the CEO created via `create_project`; author the coherence ticket description first.',
	},
	list_team_templates: {
		category: 'Projects',
		returns:
			'An array of templates (`id`, `name`, `description`, `is_builtin`, `agent_types[]` where each entry has `slug`, `name`, `role_description`).',
	},
	update_project_progress: {
		category: 'Projects',
		returns:
			'`{ summary, updated_at }` after replacing the project’s progress summary (shown at the top of the Progress page). Returns `{ error }` if the project is HQ/internal (no progress summary) or the call is not from within an agent run.',
		auth: 'Captain only, and only from within a progress-update agent run.',
	},

	// Tasks
	list_tasks: {
		category: 'Tasks',
		returns:
			'Up to 50 task rows ordered newest-first, each including `project_name`. With `excerpt_chars`, `description` and `rules` are replaced with excerpts plus `_truncated`/`_length` companions.',
	},
	get_task: {
		category: 'Tasks',
		returns:
			'The task row plus `blockers[]` (upstream) and `dependents[]` (downstream); each entry has `dependency_id`, `id`, `identifier`, `title`, `status`. Returns `null` if the task is not found.',
	},
	create_task: {
		category: 'Tasks',
		returns:
			'The created task row (it may carry an advisory `warning` string when the description backticked a real entity). Returns `{ error }` on a validation failure.',
		auth: 'An agent caller may only assign to itself or a direct subordinate; sub-task depth is capped at 2.',
	},
	create_tasks: {
		category: 'Tasks',
		returns:
			'An array of per-item results: `{ ok: true, index, task }` or `{ ok: false, index, error }`. Items are created in order; a per-item failure does not abort the rest. `blocked_by_task_ids` may reference an earlier item with a `#<index>` token.',
		auth: 'Same as `create_task`; up to 50 items per call.',
	},
	update_task: {
		category: 'Tasks',
		returns:
			'The updated task row (may carry a `warning` string), `{ unchanged: true }` when no fields changed, `null` if not found, or `{ error }` on a validation failure.',
		auth: '`done` is the final completed state; marking a ticket `done` wakes Coach to review it but the task stays `done`. `cancelled` is for abandoned work. Agents cannot set `done` while an @admin mention on the task is unanswered by a human; human admins are exempt. Only the admin can re-open a completed (`done`/`cancelled`) task. An agent run is scoped to its own task and may reassign only to itself or a direct subordinate.',
	},
	add_task_blocker: {
		category: 'Tasks',
		returns:
			'The dependency row (`id`, `task_id`, `blocked_by_task_id`, `created_at`). Returns `{ error }` for a self-block, an existing dependency, a missing task, or a cycle.',
	},
	remove_task_blocker: {
		category: 'Tasks',
		returns:
			'`{ removed: true }`, or `{ error }` if the dependency or blocker is not found. Clearing the last open blocker wakes the downstream assignee.',
	},

	// Goals
	list_goals: {
		category: 'Goals',
		returns:
			"An array of the project's goal rows, each with `project_name`/`project_slug` and an embedded `history[]` of recent progress snapshots (`{ t, percent, health }`). Archived goals are excluded unless `include_archived` is true.",
	},
	update_goal_progress: {
		category: 'Goals',
		returns:
			'The updated goal row (with the new `progress_percent`, `health`, `status_blurb`, and a refreshed `last_checked_at`). Appends a point to the goal’s progress history keyed to the calling run. Returns `{ error }` if the goal is not in the project or the inputs are invalid.',
		auth: 'Captain only, and only from within a progress-update agent run (the run records the history point).',
	},

	// Comments & reactions
	list_comments: {
		category: 'Comments & reactions',
		returns:
			'Up to 50 comment rows newest-first, each with `id`, `public_id`, `task_id`, `author_member_id`, `author_api_key_id`, `parent_comment_id`, `content_type`, `content`, `chosen_option`, `created_at`, `author_type`, `author_name`, `reactions[]`, and `attachments[]`. Pass `before` to walk older; `excerpt_chars` truncates text comments (adds `text_truncated`/`text_length`).',
	},
	create_comment: {
		category: 'Comments & reactions',
		returns:
			"The created comment row (`id`, `public_id`, `created_at`, …), optionally with an advisory `warning` string. Returns `{ error }` if `parent_comment_id` does not belong to the task. Setting `parent_comment_id` wakes the parent comment's author.",
	},
	update_comment: {
		category: 'Comments & reactions',
		returns:
			'The updated comment row, optionally with an advisory `warning` string. Returns `{ error }` if the comment is not a text comment the caller authored during the current run. Re-runs create-time side effects (mention/reply wakeups, task links) idempotently, so only references the edit newly introduces notify anyone.',
		auth: 'An agent editing a text comment its own current run authored. Comments from earlier runs, other agents, or humans are not editable.',
	},
	add_reaction: {
		category: 'Comments & reactions',
		returns:
			'`{ comment_id, kind, reactions[] }`, or `{ error }` if the comment is invalid. Reacting does not wake the comment author.',
	},
	remove_reaction: {
		category: 'Comments & reactions',
		returns: '`{ comment_id, kind, reactions[] }`, or `{ error }` if the reaction is not found.',
	},

	// Agents & hiring
	list_agents: {
		category: 'Agents & hiring',
		returns:
			'An array of agent rows (`id`, `agent_type_id`, `title`, `slug`, `daily_budget_cents`, `weekly_budget_cents`, `monthly_budget_cents`, `runtime_status`, `admin_status`).',
	},
	create_hire_proposal: {
		category: 'Agents & hiring',
		returns:
			'`{ approval_id, status, payload }` for the new pending hire approval, or `{ error }` if the spec is rejected (missing title, invalid effort/budget, reserved or duplicate slug, or an unknown `task_id`).',
		auth: 'A team Captain (for its own team) or the CEO (for any team — pass `project`, including HQ). The proposal surfaces as a pending approval for the admin.',
	},
	update_hire_proposal: {
		category: 'Agents & hiring',
		returns:
			'The updated approval row, or `{ error }` if no field changed or the approval is invalid.',
		auth: "Captain only; the approval must be a pending hire request on the Captain's team.",
	},
	set_agent_status: {
		category: 'Agents & hiring',
		returns:
			'`{ updated: true, agent_id, slug, admin_status }`, or `{ error }`. Disabling unassigns the agent from every open task; the change is reversible.',
		auth: "The team's Captain or the CEO. The Captain, CEO, and Coach roles cannot be disabled with this tool.",
	},
	report_no_work: {
		category: 'Agents & hiring',
		returns:
			'`{ ok: true }`, or `{ error }` outside an agent run. Records the run as an intentional no-op so it is not flagged as a failed empty run.',
		auth: 'Available only within an agent run (requires a run identity).',
	},

	// Agent prompts & context
	update_chat_memory: {
		category: 'Agent prompts & context',
		returns:
			"`{ written: true, updated_at }`. Overwrites the calling agent's long-term chat memory wholesale (no append; no revision history).",
		auth: 'An agent updating its own memory only.',
	},
	get_agent_system_prompt: {
		category: 'Agent prompts & context',
		returns:
			'`{ title, slug, system_prompt }`, or `{ error }` if the agent is not in the team. By default `{{…}}` placeholders are resolved; pass `placeholders: false` for the raw stored template.',
		auth: 'Any agent or the admin in the same team.',
	},
	get_agent_system_prompts: {
		category: 'Agent prompts & context',
		returns:
			'An array of per-item results: `{ index, ok: true, title, slug, system_prompt }` or `{ index, ok: false, agent_id, error }`. Up to 50 items; each `mode` is `placeholders` (default), `preview`, or `raw`.',
		auth: 'Any agent or the admin in the same team.',
	},
	update_agent_system_prompt: {
		category: 'Agent prompts & context',
		returns:
			'`{ applied: true, document_id }`, or `{ error }` if denied or the agent is not in the team. A revision snapshot is stored so the admin can restore previous versions.',
		auth: "The Coach or the team's Captain.",
	},
	set_agent_summary: {
		category: 'Agent prompts & context',
		returns:
			'`{ updated: true }`, or `{ error }` (summary empty, over 1000 chars, or agent not in team).',
		auth: 'Any agent or the admin in the same team (the Captain is the expected caller; agents may self-summarise).',
	},
	set_team_summary: {
		category: 'Agent prompts & context',
		returns: '`{ updated: true }`, or `{ error }` (summary empty or over 4000 chars).',
		auth: "The team's Captain only.",
	},
	set_agent_team_context: {
		category: 'Agent prompts & context',
		returns:
			'`{ updated: true }`, or `{ error }` (content empty, over 6000 chars, or agent not in team).',
		auth: "The team's Captain only.",
	},
	get_agent_team_context: {
		category: 'Agent prompts & context',
		returns: '`{ title, slug, team_context }`, or `{ error }` if the agent is not in the team.',
		auth: 'Any agent or the admin in the same team.',
	},
	set_agent_reports_to: {
		category: 'Agents & hiring',
		returns:
			'`{ applied: true, agent, reports_to }` (`reports_to` is null when cleared), or `{ error }` if the agent/manager is not in the team, the target is the Captain/CEO/Coach (whose reporting lines are fixed), the manager is the agent itself, or the link would create a reporting cycle.',
		auth: "The team's Captain, or an HQ instance agent (CEO/Coach) acting in the team.",
	},

	// Approvals
	list_approvals: {
		category: 'Approvals',
		returns:
			'An array of pending approval rows (`id`, `team_id`, `type`, `status`, `requested_by_member_id`, `resolution_note`, `resolved_at`, `created_at`, `payload`). `excerpt_chars` truncates long string fields inside `payload`.',
	},
	resolve_approval: {
		category: 'Approvals',
		returns: 'The updated approval row, or `{ error }` if not found or denied.',
		auth: "Authorized against the approval's own team/project; an agent run must be scoped to act on it.",
	},

	// Skills & search
	list_skills: {
		category: 'Skills & search',
		returns:
			'`{ skills: [{ id, name, slug, description, tags, created_at, updated_at }] }`. Pass `tags` (comma-separated) to filter.',
	},
	get_skill: {
		category: 'Skills & search',
		returns: 'The full skill row (including `content`), or `{ error }` if not found.',
	},
	create_skill: {
		category: 'Skills & search',
		returns:
			'`{ skill_id, slug, created: true }`. Upserts by `slug` and writes a skill revision; `description` is derived from the body when omitted.',
	},
	propose_skill: {
		category: 'Skills & search',
		returns:
			'`{ approval_id, status }` — creates a skill-proposal approval that writes the skill when approved.',
	},
	full_text_search: {
		category: 'Skills & search',
		returns:
			'`{ results, count }` — full-text (keyword + stemming) matches ranked by relevance across skills, tasks, project docs, and comments.',
	},

	// Credentials & connectors
	request_credential: {
		category: 'Credentials & connectors',
		returns:
			'`{ placeholder, comment_id, status: "pending", reused }`. The agent never sees the value; it embeds `placeholder` (`__HEZO_SECRET_<NAME>__`) and the egress proxy substitutes the real value. Returns `{ error }` for an invalid name, or for an HTTP-auth kind requested without `allowed_hosts`. Idempotent on `name`.',
	},
	register_connector: {
		category: 'Credentials & connectors',
		returns:
			'`{ connector_id, status, name, display_name, comment_id?, reused }`. `status` is `active` (OAuth already complete) or `pending` (a connect_required comment is posted for the human). Idempotent.',
	},
	fetch_skill_file: {
		category: 'Credentials & connectors',
		returns:
			'`{ skill_id, slug, source_url, size_bytes, reused }`, or `{ error }` (invalid URL, non-HTTP(S), over 256 KB, or fetch failure). Stored as an auto-load global skill; idempotent on the derived slug.',
	},

	// MCP connections
	list_mcp_connections: {
		category: 'MCP connections',
		returns:
			'An array of connector rows with a derived `oauth_status` (`active` | `pending` | `failed` | `revoked` | `none`) and, for an active OAuth-backed connector, `rest_auth` = `{ placeholder, allowed_hosts, scopes }` (else `null`). Other fields include `id`, `name`, `display_name`, `kind`, `config`, `project_id`, `oauth_account_label`, `install_status`, `install_error`, `skill_id`, `created_by_task_id`, `activated_at`, `revoked_at`, `auth_error`. Scoped to your project: its own connectors plus global ("all projects") ones, with a project connector shadowing a global one of the same name.',
	},
	test_connector: {
		category: 'MCP connections',
		returns:
			'`{ ok, status, mcp_url, secret_name, token_prefix, token_length, www_authenticate, body_excerpt, hint }` from a direct server-side probe of the MCP URL. Returns `{ error }` if the connector is missing, not `saas`, or its token cannot be decrypted.',
	},
	add_mcp_connection: {
		category: 'MCP connections',
		returns:
			'`{ id, install_status, note }`, or `{ error }` if `config.url` (saas) / `config.command` (local) is missing. Upserts by `name` within your project.',
	},
	remove_mcp_connection: {
		category: 'MCP connections',
		returns:
			"`{ removed: true, id }`, or `{ error }` if the connection is not found. Removes only your project's own connector (never a global or another project's).",
	},

	// Project docs & assets
	list_project_docs: {
		category: 'Project docs & assets',
		returns:
			"`{ files: [{ id, filename, title, status, updated_at }] }` — the markdown project docs. `status` is the doc's lifecycle status (`planning` or `approved`). The `filter` param defaults to `'active'` (archived docs excluded); with `'archived'` or `'all'` each entry also carries `archived: boolean`.",
	},
	read_project_doc: {
		category: 'Project docs & assets',
		returns:
			"`{ filename, content, status }` (the full markdown body plus the doc's lifecycle status, `planning` or `approved`), plus `review_comments: [{ id, quote, occurrence, comment, created_at }]` when the admin has left pending review feedback on the doc (each comment anchors to an exact `quote` snippet; `occurrence` disambiguates repeats). Any write to the doc deletes all of its review comments, so capture them before writing. Returns `{ error }` if the file is not found or its archive state doesn't match `filter` (default `'active'`, so archived docs need `filter: 'archived'` or `'all'`; an archived read carries `archived: true`).",
	},
	write_project_doc: {
		category: 'Project docs & assets',
		returns:
			"`{ written: true, id, filename }`, or `{ error }` if the filename is not `.md` or the doc is archived (unarchive first — archived docs are read-only). Make all edits in one consolidated write: a content-changing write deletes ALL pending review comments on the doc (read them first) and records a document revision, so many partial writes lose review context and bury the revision history. The optional `changelog` is stored as that revision's changelog and shown in the document's history — put update/status notes there, not in the document body.",
	},
	set_project_doc_status: {
		category: 'Project docs & assets',
		returns:
			'`{ updated: true, filename, status }`, or `{ error }` if the file is not found or archived. Status is metadata only — no content change, no revision recorded.',
	},
	archive_project_doc: {
		category: 'Project docs & assets',
		returns:
			'`{ archived: true, filename, changed }` (`changed: false` when it was already archived — the call is idempotent), or `{ error }` if the file is not found. The archived doc leaves listings, search, and agent-run context but keeps its filename reserved and its revision history.',
		auth: 'Archival is the agent-facing soft delete; hard deletion of docs is admin-only in the web app.',
	},
	unarchive_project_doc: {
		category: 'Project docs & assets',
		returns:
			'`{ archived: false, filename, changed }` (`changed: false` when it was already active), or `{ error }` if the file is not found.',
	},
	list_project_assets: {
		category: 'Project docs & assets',
		returns:
			"`{ files: [{ id, filename, content_type, created_at }] }` — the project asset files. `filename` is the full path and may carry a folder prefix up to 2 levels (e.g. `launch/images/hero.png`). The `filter` param defaults to `'active'` (archived assets excluded); with `'archived'` or `'all'` each entry also carries `archived: boolean`.",
	},
	read_project_asset: {
		category: 'Project docs & assets',
		returns:
			"For a text asset, `{ filename, content_type, content }`. For a binary asset, `{ filename, content_type, byte_size, binary: true, url }` — a signed download URL valid for 24h; fetch it with plain `curl` (no auth header), and re-call the tool for a fresh one if it expires. Either shape also carries `review_comments: [{ id, quote?, occurrence?, comment, created_at }]` when the admin has left pending review feedback on the asset: on a text asset (markdown, plain text) a comment anchors to an exact `quote` snippet (`occurrence` disambiguates repeats); a comment without a quote applies to the whole file. Any write to the asset's path deletes all of its review comments, so capture them before writing. Returns `{ error }` if not found — match the full path, folder prefix included — or if the asset's archive state doesn't match `filter` (default `'active'`, so archived assets need `filter: 'archived'` or `'all'`; an archived read carries `archived: true`).",
	},
	write_project_asset: {
		category: 'Project docs & assets',
		returns:
			'`{ written: true, id, reference: "assets/<path>" }`, or `{ error }` if the type is not text-based (`.html`, `.svg`, `.txt`, `.md`, or a script/text format: `.sh`, `.py`, `.js`, `.ts`, `.json`, `.csv`, `.yaml`, `.yml`), the path is invalid (max 2 folder levels), the content exceeds 10 MB, or an archived asset holds the path (unarchive it first or pick another path). Re-saving the same path overwrites it; matching is path-exact. Overwriting deletes ALL pending review comments on the asset (the admin feedback returned by read_project_asset) — read them first and make all edits in one consolidated write.',
	},
	move_project_asset: {
		category: 'Project docs & assets',
		returns:
			'`{ moved: true, id, from, reference: "assets/<path>", note }`, or `{ error }` when the source is missing or archived, the destination exists (moves never overwrite; an archived asset still holds its path), the extension changes, or a path is invalid. Metadata-only — the stored bytes do not move. Existing text references to the old path are not rewritten.',
	},
	copy_project_asset: {
		category: 'Project docs & assets',
		returns:
			'`{ copied: true, id, reference: "assets/<path>" }` — a new asset with its own id, any type including binary. Returns `{ error }` when the source is missing or archived, the destination exists (copies never overwrite), or a path is invalid.',
	},
	archive_project_asset: {
		category: 'Project docs & assets',
		returns:
			'`{ archived: true, reference: "assets/<path>", changed }` (`changed: false` when it was already archived — the call is idempotent), or `{ error }` if the asset is not found. The archived asset leaves listings and default reads but keeps its path reserved; existing `assets/<path>` references keep resolving.',
		auth: 'Archival is the agent-facing soft delete; hard deletion of assets is admin-only in the web app.',
	},
	unarchive_project_asset: {
		category: 'Project docs & assets',
		returns:
			'`{ archived: false, reference: "assets/<path>", changed }` (`changed: false` when it was already active), or `{ error }` if the asset is not found.',
	},

	// Costs
	get_costs: {
		category: 'Costs',
		returns:
			'With `group_by: "agent"`, an array of `{ member_id, agent_title, total_cents }`; with `group_by: "day"`, an array of `{ day, total_cents }`; otherwise `{ total_cents, entry_count }`.',
	},

	// Onboarding
	register: {
		category: 'Onboarding',
		returns:
			'`{ id, token, status, message }` — the `hezo_…` token is shown once. Returns `{ error }` if `name` is missing.',
		auth: 'No token required — this is how an external agent self-registers. The registration stays inert until a Hezo admin approves it.',
	},
	connection_status: {
		category: 'Onboarding',
		returns: '`{ status: "pending" | "approved" }`, or `{ error }` if no/unknown token is sent.',
		auth: 'Keyed by the bearer token from `register`; no approved principal required.',
	},
};

/** Render the JSON Schema type of one parameter as a table-safe cell. */
function typeCell(schema: Record<string, unknown> | undefined): string {
	if (!schema || typeof schema !== 'object') return '`any`';
	const enumVals = schema.enum;
	if (Array.isArray(enumVals)) return enumVals.map((v) => `\`${String(v)}\``).join(' \\| ');
	const anyOf = schema.anyOf;
	if (Array.isArray(anyOf)) {
		return anyOf.map((s) => typeCell(s as Record<string, unknown>)).join(' \\| ');
	}
	return `\`${baseType(schema)}\``;
}

/** Base type label (no backticks), recursing into array element types. */
function baseType(schema: Record<string, unknown>): string {
	const t = schema.type;
	if (t === 'array') {
		return `${baseType((schema.items as Record<string, unknown>) ?? {})}[]`;
	}
	let label = Array.isArray(t) ? t.join('/') : typeof t === 'string' ? t : 'object';
	if (typeof schema.format === 'string') label += ` (${schema.format})`;
	return label;
}

/** Make a string safe to drop into a markdown table cell. */
function escapeCell(s: string): string {
	return s
		.replace(/\|/g, '\\|')
		.replace(/\r?\n+/g, ' ')
		.trim();
}

/** Render a tool's parameter table (or a "none" line). */
function renderParams(schema: Record<string, unknown>): string[] {
	const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
	const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
	const names = Object.keys(props);
	if (names.length === 0) return ['**Parameters:** none.'];
	const lines = [
		'**Parameters:**',
		'',
		'| Parameter | Type | Required | Description |',
		'| --- | --- | --- | --- |',
	];
	for (const name of names) {
		const p = props[name] ?? {};
		const isRequired = required.has(name) && p.default === undefined;
		const desc = typeof p.description === 'string' ? p.description : '';
		lines.push(
			`| \`${name}\` | ${typeCell(p)} | ${isRequired ? 'Yes' : 'No'} | ${escapeCell(desc)} |`,
		);
	}
	return lines;
}

/** Render one tool's section. */
function renderTool(tool: McpReferenceTool, meta: ToolDocMeta): string[] {
	const lines = [`### \`${tool.name}\``, '', tool.write ? '_Write tool._' : '_Read-only._', ''];
	lines.push(tool.description.trim(), '');
	lines.push(...renderParams(tool.schema), '');
	lines.push(`**Returns:** ${meta.returns}`, '');
	if (meta.auth) lines.push(`**Authorization:** ${meta.auth}`, '');
	return lines;
}

/**
 * Build the complete `docs/reference/mcp-api.md` markdown (frontmatter included)
 * from the registered tools and the onboarding tools. Deterministic: tools keep
 * registry order within each category, and categories follow
 * `MCP_REFERENCE_CATEGORY_ORDER`.
 */
export function generateMcpReference(
	tools: McpReferenceTool[],
	onboarding: McpReferenceTool[],
): string {
	const all = [...tools, ...onboarding];
	const byCategory = new Map<string, McpReferenceTool[]>();
	for (const tool of all) {
		const meta = TOOL_DOC_META[tool.name];
		if (!meta) continue; // completeness is enforced by the test, not the generator
		const list = byCategory.get(meta.category) ?? [];
		list.push(tool);
		byCategory.set(meta.category, list);
	}

	const lines: string[] = [
		'---',
		'title: MCP API reference',
		'order: 32',
		'section: Reference',
		'---',
		'',
		'<!-- GENERATED FILE — do not edit by hand. Source: packages/server/src/mcp/mcp-reference.ts',
		'     (generator + per-tool metadata) and the live MCP tool registry. Regenerate with',
		'     `bun run build:docs`; mcp-reference.test.ts fails if this file is stale. -->',
		'',
		'# MCP API reference',
		'',
		"Complete reference for every tool exposed by Hezo's built-in MCP server. For how to",
		'connect, authenticate, and register for access, see',
		"[Hezo's MCP server](/docs/mcp/hezo-mcp-server).",
		'',
		'## Connecting',
		'',
		'- **Endpoint:** `POST /mcp` — JSON-RPC 2.0 over Streamable HTTP.',
		'- **Authentication:** `Authorization: Bearer <token>`, where the token is an',
		'  instance-scoped API key (`hezo_…`).',
		'- **Discovery:** call `tools/list` for the live machine-readable schemas, then invoke a',
		'  tool with `tools/call`.',
		'- **File uploads:** binary files cannot ride a JSON-RPC call — `POST` them to',
		'  `/mcp/assets` as `multipart/form-data` (a `file` field, plus an optional `project`',
		'  field). They then appear in `list_project_assets` / `read_project_asset`.',
		'',
		'## Conventions',
		'',
		'- **Project scope (`project`):** most tools take an optional `project` (slug or ID).',
		'  Omit it to act in the project your run is already in; an API key and instance agents',
		'  (CEO/Coach) must name the project they are acting in.',
		"- **Authorization:** every call is scoped to the resolved project's team and the caller",
		'  must have access to it. Tools that restrict callers further note it under',
		'  **Authorization** below.',
		'- **Errors:** a handled failure comes back as `{ "error": "<message>" }` in the tool',
		'  result (the HTTP response itself stays successful).',
		'- **Result size:** a tool result is capped at 64 KB (higher for a few',
		'  full-resource inspection tools, e.g. `get_agent_system_prompts`); over the',
		'  cap you get `{ "error": "result_too_large", … }`. Narrow it with filters, a',
		'  single-resource `get_*`, `before` pagination, or `excerpt_chars`.',
		'- **Excerpts (`excerpt_chars`):** list tools accept `excerpt_chars` to truncate long',
		'  text fields, adding `_truncated`/`_length` companions.',
		'- **Pagination (`before`):** `list_comments` walks older items by passing the oldest',
		'  `id` you have seen as `before`.',
		'- **Secrets:** agents reference secrets by placeholder (`__HEZO_SECRET_<NAME>__`); the',
		"  egress proxy substitutes the real value only for the secret's `allowed_hosts`.",
		'- **Write tools:** tools marked _Write tool_ persist data — a successful call from an',
		'  agent run marks the run as having produced output.',
		'',
	];

	for (const category of MCP_REFERENCE_CATEGORY_ORDER) {
		const toolsInCategory = byCategory.get(category);
		if (!toolsInCategory || toolsInCategory.length === 0) continue;
		lines.push(`## ${category}`, '');
		for (const tool of toolsInCategory) {
			lines.push(...renderTool(tool, TOOL_DOC_META[tool.name]));
		}
	}

	lines.push('---', '', `Generated from the MCP tool registry. Full docs: ${HEZO_DOCS_URL}`, '');

	return `${lines.join('\n').trimEnd()}\n`;
}

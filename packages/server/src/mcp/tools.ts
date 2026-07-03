import { AsyncLocalStorage } from 'node:async_hooks';
import type { PGlite } from '@electric-sql/pglite';
import type { SearchScope } from '@hezo/shared';
import {
	ADMIN_MENTION_SLUG,
	AgentAdminStatus,
	ApprovalStatus,
	ApprovalType,
	ASSET_MAX_FOLDER_DEPTH,
	ATTACHMENT_EXTENSIONS,
	ATTACHMENT_MAX_BYTES,
	AuditActorType,
	AuthType,
	assetBasename,
	CAPTAIN_AGENT_SLUG,
	CAPTAIN_SETTABLE_GOAL_HEALTH,
	CEO_AGENT_SLUG,
	COACH_AGENT_SLUG,
	CommentContentType,
	CredentialInputType,
	CredentialKind,
	credentialKindRequiresAllowedHosts,
	DEFAULT_TEAM_ID,
	DocumentType,
	extensionOf,
	extractBacktickedMentionCandidates,
	type GoalHealth,
	getConnectorCapability,
	hasFixedReportsTo,
	INSTANCE_AGENT_SLUGS,
	isAgentAuthorableAssetMime,
	isMarkdownDocSlug,
	normalizeAssetPath,
	REQUIRED_SYSTEM_PROMPT_VARS,
	ReactionKind,
	requiredSystemPromptVarsError,
	SEARCH_SCOPES,
	TaskStatus,
	TERMINAL_TASK_STATUSES,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MasterKeyManager } from '../crypto/master-key';
import type { DomainEventBus } from '../events/bus';
import { assertNoActiveRun } from '../lib/active-run';
import { isCoach, isHqInstanceAgent, isVirtualHqMemberInTeam } from '../lib/agent-roles';
import { upsertProjectAsset } from '../lib/asset-name';
import { assertSubordinateAssignee } from '../lib/assignment-hierarchy';
import { trackBackground } from '../lib/background';
import { broadcastCommentFamilyChange, broadcastRowChange } from '../lib/broadcast';
import { credentialPlaceholder, validateSecretName } from '../lib/credential-placeholder';
import {
	coerceTargetStatusForBlockers,
	reconcileBlockedStatus,
	wakeIfReady,
	wouldCreateCycle,
} from '../lib/dependencies';
import { detectUnlinkedTeammateReferences, extractMentionSlugs } from '../lib/mentions';
import {
	actorTypeFromAuth,
	apiKeyIdFromAuth,
	resolveActorMemberId,
	resolveAgentId,
	resolveProject,
	resolveTaskId,
} from '../lib/resolve';
import { assertRunTaskScope } from '../lib/run-scope';
import { deriveSkillSummary } from '../lib/skill-summary';
import { isUniqueViolation } from '../lib/sql';
import {
	assertChildrenAllClosed,
	assertNoOutstandingActivity,
	assertNoUnansweredAdminMentions,
} from '../lib/task-relationships';
import type { AuthInfo } from '../lib/types';
import { logger } from '../logger';
import { setAgentAdminStatus } from '../services/agent-admin';
import { AGENT_ATTACHMENT_DIR, loadAgentAttachmentsForComments } from '../services/agent-runner';
import {
	AgentSystemPromptError,
	fetchAgentSystemPromptForBatch,
	type SystemPromptMode,
} from '../services/agent-system-prompts';
import { broadcastApprovalChange } from '../services/approval-broadcast';
import { resolveApproval } from '../services/approval-resolve';
import { deleteAsset, readAsset, writeAsset } from '../services/asset-storage';
import { upsertChatMemory } from '../services/chat-memory';
import { fireAdminMention, fireCommentWakeups } from '../services/comment-wakeups';
import type { ContainerDeps } from '../services/containers';
import { enqueueTeamCoherenceReviewTask } from '../services/description-tasks';
import { listReviewComments } from '../services/document-review';
import {
	getAgentSystemPrompt,
	getDocument,
	listDocuments,
	upsertDocument,
} from '../services/documents';
import { listGoals, recordGoalProgress } from '../services/goals';
import {
	buildHirePayloadPatch,
	type HirePayloadPatchInput,
	type HireProposalInput,
	insertHireApproval,
	prepareHireProposal,
} from '../services/hire-proposal';
import { insertHireProposalComment } from '../services/hire-proposal-comment';
import { createProjectWithTeam } from '../services/project-create';
import { completeProjectIntakeAfterProvisioning } from '../services/project-intake';
import { ProjectProgressError, updateProjectProgress } from '../services/projects';
import {
	addCommentReaction,
	loadReactionsForTask,
	removeCommentReaction,
} from '../services/reactions';
import { recordSkillRevisionIfChanged } from '../services/skill-revisions';
import { triggerStatusAutomations } from '../services/task-automation';
import { recordTaskLinks } from '../services/task-events';
import {
	type CreateTaskCaller,
	CreateTaskError,
	type CreateTaskInput,
	createTask,
	createTaskBatch,
	TASK_COLUMNS_BARE,
} from '../services/tasks';
import { resolveSystemPrompt } from '../services/template-resolver';
import { createWakeup } from '../services/wakeup';
import type { WebSocketManager } from '../services/ws';

const log = logger.child('mcp');

export const authContext = new AsyncLocalStorage<AuthInfo>();

export interface ToolDef {
	name: string;
	description: string;
	schema: Record<string, unknown>;
	/**
	 * JSON Schema of the tool's input parameters, derived from the Zod shape at
	 * registration. Consumed by the docs generator (`mcp-reference.ts`) to render
	 * the per-tool parameter tables; the live MCP `tools/list` schema is produced
	 * independently by the SDK.
	 */
	params: Record<string, unknown>;
	/**
	 * True when the tool persists data (it is in `MCP_WRITE_TOOLS`): a successful
	 * call from an agent run marks the run as having produced output.
	 */
	write: boolean;
}

const registeredTools: ToolDef[] = [];

// Tools that persist data. When an agent run invokes one of these and it
// succeeds, the run has produced output — recorded on the run row so the
// completion path can distinguish a useful run from a no-op that merely exited
// cleanly. Read-only tools (list_*/get_*/read_*/semantic_search/test_connector)
// and run-local fetches (fetch_skill_file) are excluded.
const MCP_WRITE_TOOLS: ReadonlySet<string> = new Set([
	'create_team',
	'create_task',
	'create_tasks',
	'update_task',
	'add_task_blocker',
	'remove_task_blocker',
	'update_hire_proposal',
	'create_hire_proposal',
	'create_project',
	'start_team_setup',
	'add_reaction',
	'remove_reaction',
	'create_comment',
	'update_comment',
	'request_credential',
	'request_asset_deletion',
	'register_connector',
	'resolve_approval',
	'update_agent_system_prompt',
	'set_agent_status',
	'set_agent_summary',
	'set_team_summary',
	'set_agent_team_context',
	'set_agent_reports_to',
	'write_project_asset',
	'move_project_asset',
	'copy_project_asset',
	'write_project_doc',
	'update_chat_memory',
	'propose_skill',
	'create_skill',
	'add_mcp_connection',
	'remove_mcp_connection',
	'update_goal_progress',
	'update_project_progress',
]);

/** A handler result that signals failure rather than a persisted write. */
function isErrorResult(result: unknown): boolean {
	return typeof result === 'object' && result !== null && 'error' in result;
}

/**
 * Returns a warning string when a comment addresses a teammate by bold/bare name
 * instead of a mention, or null when nothing is amiss. The author's own slug is
 * excluded so a self-reference never warns; resolution mirrors the mention-wakeup
 * scoping (the task's team plus the HQ instance agents) and includes @admin.
 */
async function buildUnlinkedMentionWarning(
	db: PGlite,
	teamId: string,
	authorMemberId: string,
	content: string,
): Promise<string | null> {
	const roster = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE (m.team_id = $1 OR m.team_id = $2) AND ma.id <> $3`,
		[teamId, DEFAULT_TEAM_ID, authorMemberId],
	);
	const knownSlugs = [...roster.rows.map((r) => r.slug), ADMIN_MENTION_SLUG];
	const offenders = detectUnlinkedTeammateReferences(content, knownSlugs);
	if (offenders.length === 0) return null;
	const named = offenders.map((s) => `**${s}**`).join(', ');
	const fixes = offenders.map((s) => `@${s}`).join(', ');
	return (
		`You referenced teammate(s) ${named} by bold/plain name — that renders as text ` +
		`and notifies no one, so no wakeup was created. If you need them to act on this ` +
		`ticket, post a follow-up using an active mention (${fixes}); if you were only ` +
		`referring to them, use the passive form (@@${offenders[0]}).`
	);
}

/**
 * Returns a warning when markdown wraps an *existing* Hezo reference in inline
 * backticks — which renders it as inert code instead of a link — or null when
 * nothing is amiss. Only references that would actually resolve (a real task in
 * this team, a project doc/skill, an asset in this project, or a teammate in
 * this team or HQ) are flagged, so genuine code spans — repo paths, package
 * names, `UTF-8` — never trip it. This mirrors the renderer, which links a
 * reference only when it resolves. Best-effort and non-blocking, exactly like
 * buildUnlinkedMentionWarning.
 */
async function buildBacktickedEntityWarning(
	db: PGlite,
	teamId: string,
	projectId: string,
	content: string,
): Promise<string | null> {
	const candidates = extractBacktickedMentionCandidates(content);
	if (
		candidates.tasks.length === 0 &&
		candidates.filenames.length === 0 &&
		candidates.assets.length === 0 &&
		candidates.agents.length === 0
	) {
		return null;
	}

	const refs: string[] = [];
	let hasAgents = false;

	if (candidates.agents.length > 0) {
		const r = await db.query<{ slug: string }>(
			`SELECT ma.slug FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE (m.team_id = $1 OR m.team_id = $2) AND LOWER(ma.slug) = ANY($3::text[])`,
			[teamId, DEFAULT_TEAM_ID, candidates.agents],
		);
		for (const row of r.rows) {
			refs.push(`@${row.slug}`);
			hasAgents = true;
		}
	}

	if (candidates.tasks.length > 0) {
		const r = await db.query<{ identifier: string }>(
			`SELECT identifier FROM tasks WHERE team_id = $1 AND LOWER(identifier) = ANY($2::text[])`,
			[teamId, candidates.tasks],
		);
		for (const row of r.rows) refs.push(row.identifier);
	}

	if (candidates.filenames.length > 0) {
		const docs = await db.query<{ slug: string }>(
			`SELECT slug FROM documents
			 WHERE type = 'project_doc' AND project_id = $1 AND slug = ANY($2::text[])`,
			[projectId, candidates.filenames],
		);
		for (const row of docs.rows) refs.push(row.slug);
		const kb = await db.query<{ slug: string }>(
			`SELECT slug FROM skills WHERE LOWER(slug) = ANY($1::text[])`,
			[candidates.filenames.map((f) => f.toLowerCase())],
		);
		for (const row of kb.rows) refs.push(row.slug);
	}

	if (candidates.assets.length > 0) {
		const r = await db.query<{ original_filename: string }>(
			`SELECT original_filename FROM assets
			 WHERE project_id = $1 AND original_filename = ANY($2::text[])`,
			[projectId, candidates.assets],
		);
		for (const row of r.rows) refs.push(`assets/${row.original_filename}`);
	}

	if (refs.length === 0) return null;
	const deduped = Array.from(new Set(refs));
	const wrapped = deduped.map((ref) => `\`${ref}\``).join(', ');
	const bare = deduped.join(', ');
	return (
		`You wrapped existing Hezo reference(s) in backticks — ${wrapped} — so they render as ` +
		`inert code instead of links. Re-post with each written bare (no backticks) so it becomes ` +
		`a clickable link, exactly as in a comment: ${bare}.` +
		(hasAgents
			? ' For a teammate, @<slug> also wakes them on this ticket; use @@<slug> to refer without notifying.'
			: '')
	);
}

/**
 * Returns a warning when an agent posts an active mention (an ask) on a task
 * that is already terminal, or null otherwise. A done/cancelled task reads as
 * finished, so an ask parked on it is easy to miss — the correct move was to
 * ask before closing and keep the task in_progress/review while waiting.
 * Best-effort and non-blocking, exactly like the builders above.
 */
async function buildTerminalTaskAskWarning(
	db: PGlite,
	taskId: string,
	content: string,
): Promise<string | null> {
	if (extractMentionSlugs(content).length === 0) return null;
	const r = await db.query<{ status: string }>(
		'SELECT status::text AS status FROM tasks WHERE id = $1',
		[taskId],
	);
	const status = r.rows[0]?.status;
	if (!status || !(TERMINAL_TASK_STATUSES as readonly string[]).includes(status)) return null;
	return (
		`Note: this task is already ${status} (terminal). An ask posted on a closed task is easy ` +
		`to miss — if you still need an answer or action, ask on an open task instead; next time ` +
		`ask BEFORE closing and keep the task in_progress or review until the answer lands.`
	);
}

/**
 * Attach a backticked-entity warning, computed over `content`, to a write
 * result when the caller is an agent. The check is advisory: failures are
 * swallowed and never block the already-persisted write.
 */
async function withBacktickWarning<T extends object>(
	db: PGlite,
	auth: AuthInfo,
	teamId: string,
	projectId: string,
	content: string | undefined,
	result: T,
): Promise<T | (T & { warning: string })> {
	if (auth.type !== AuthType.Agent || !content) return result;
	const warning = await buildBacktickedEntityWarning(db, teamId, projectId, content).catch((e) => {
		log.error('Failed to check for backticked entity references:', e);
		return null;
	});
	return warning ? { ...result, warning } : result;
}

/** Flag an agent run as having produced output. Idempotent and self-contained. */
async function markRunProducedOutput(db: PGlite, runId: string): Promise<void> {
	await db.query(
		'UPDATE heartbeat_runs SET produced_output = true WHERE id = $1 AND produced_output = false',
		[runId],
	);
}

/**
 * Flag an agent run as an intentional no-op: the agent evaluated the task and
 * concluded there was nothing to do. Kept distinct from `produced_output` (which
 * means the run wrote persisted data) so the completion path can treat a clean
 * no-op as a success without it masquerading as a productive run.
 */
async function markRunReportedNoWork(db: PGlite, runId: string, reason: string): Promise<void> {
	await db.query(
		'UPDATE heartbeat_runs SET reported_no_work = true, no_work_reason = $2 WHERE id = $1',
		[runId, reason],
	);
}

// Qualified-column variant of services/tasks.ts TASK_COLUMNS_BARE — prefixes
// every column with the `i.` alias for SELECT ... FROM tasks i JOIN ...
// patterns.
const TASK_COLUMNS = TASK_COLUMNS_BARE.replace(/[A-Za-z_][A-Za-z_0-9]*/g, 'i.$&');

const SKILL_COLUMNS = `id, name, slug, description, content, source_url,
	content_hash, created_by_member_id, tags, is_active, auto_load, created_at, updated_at`;

const APPROVAL_COLUMNS = `id, team_id, type, status, requested_by_member_id,
	resolution_note, resolved_at, created_at, payload`;

// Cap MCP tool result payloads at 24 000 bytes — comfortably under the
// Claude Code harness's ~25k-token tool-result limit. Oversized results would
// otherwise be persisted to disk by the harness and become unreadable for the
// agent (the persisted file itself trips the same cap).
export const MCP_RESULT_BYTE_LIMIT = 64_000;

export interface Excerpt {
	excerpt: string | null;
	truncated: boolean;
	length: number;
}

/**
 * Excerpt the leading paragraph of `text`, capped at `maxChars` with a
 * word-boundary cut. Returns `null` excerpt for null/empty input.
 */
export function excerpt(text: string | null | undefined, maxChars: number): Excerpt {
	if (text == null) return { excerpt: null, truncated: false, length: 0 };
	const length = text.length;
	if (length === 0) return { excerpt: '', truncated: false, length: 0 };
	const firstPara = text.split(/\n\s*\n/, 1)[0] ?? text;
	if (firstPara.length <= maxChars) {
		return { excerpt: firstPara, truncated: firstPara !== text, length };
	}
	const slice = firstPara.slice(0, maxChars);
	const lastSpace = slice.lastIndexOf(' ');
	const cut = lastSpace > maxChars * 0.5 ? slice.slice(0, lastSpace) : slice;
	return { excerpt: cut, truncated: true, length };
}

/**
 * Spread an Excerpt into a row under `<field>_excerpt`/`_truncated`/`_length`.
 */
function applyExcerpt<T extends Record<string, unknown>>(
	row: T,
	field: string,
	maxChars: number,
): T {
	const value = row[field];
	const ex = excerpt(typeof value === 'string' ? value : null, maxChars);
	const next = { ...row } as Record<string, unknown>;
	delete next[field];
	next[`${field}_excerpt`] = ex.excerpt;
	next[`${field}_truncated`] = ex.truncated;
	next[`${field}_length`] = ex.length;
	return next as T;
}

/**
 * Excerpt long string fields inside an approval payload (most importantly the
 * `content` markdown of a skill_proposal). Leaves short fields and non-string
 * fields untouched.
 */
function excerptApprovalPayload<T extends Record<string, unknown>>(row: T, maxChars: number): T {
	const payload = row.payload;
	if (!payload || typeof payload !== 'object') return row;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
		if (typeof value !== 'string' || value.length <= maxChars) {
			next[key] = value;
			continue;
		}
		const ex = excerpt(value, maxChars);
		next[`${key}_excerpt`] = ex.excerpt;
		next[`${key}_truncated`] = ex.truncated;
		next[`${key}_length`] = ex.length;
	}
	return { ...row, payload: next };
}

function tool(
	server: McpServer,
	name: string,
	description: string,
	schema: Record<string, z.ZodType>,
	handler: (args: Record<string, unknown>, db: PGlite, auth: AuthInfo) => Promise<unknown>,
	db: PGlite,
) {
	registeredTools.push({
		name,
		description,
		schema: Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, v.description ?? k])),
		params: z.toJSONSchema(z.object(schema)) as Record<string, unknown>,
		write: MCP_WRITE_TOOLS.has(name),
	});
	server.tool(name, description, schema, async (args: Record<string, unknown>) => {
		const auth = authContext.getStore();
		if (!auth) {
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ error: 'Unauthorized: missing auth context' }),
					},
				],
			};
		}
		const result = await handler(args, db, auth);
		if (
			auth.type === AuthType.Agent &&
			auth.runId &&
			MCP_WRITE_TOOLS.has(name) &&
			!isErrorResult(result)
		) {
			await markRunProducedOutput(db, auth.runId);
		}
		const text = JSON.stringify(result, null, 2);
		const sizeBytes = Buffer.byteLength(text, 'utf8');
		if (sizeBytes > MCP_RESULT_BYTE_LIMIT) {
			const guard = JSON.stringify(
				{
					error: 'result_too_large',
					tool: name,
					size_bytes: sizeBytes,
					limit_bytes: MCP_RESULT_BYTE_LIMIT,
					hint: 'Narrow the query — add filters, fetch a single resource via get_*, paginate with `before` (where supported), or pass `excerpt_chars: 300` to truncate long fields.',
				},
				null,
				2,
			);
			return { content: [{ type: 'text' as const, text: guard }] };
		}
		return { content: [{ type: 'text' as const, text }] };
	});
}

/**
 * Recover the static types `server.tool` erases. The SDK validates `args`
 * against the tool's zod shape (presence + type) and rejects bad input with a
 * JSON-RPC error before the handler runs, but it then hands the handler an
 * untyped `Record<string, unknown>`. Re-parsing against the same shape returns a
 * typed object and, in practice, never throws (the SDK already enforced it).
 *
 * The point is branch reduction: without it, handlers re-derive every field with
 * a `typeof args.x === 'string' ? args.x : default` ternary, and the non-string
 * arm is unreachable for schema-required fields — dead branches that dragged
 * coverage down across the tool surface. Reading `input.x` off the typed result
 * deletes them. Genuinely value-dependent guards (an *empty* required string, a
 * cross-field rule) stay in the handler, since `z.string()` still admits `""`.
 */
function typedArgs<S extends z.ZodRawShape>(
	shape: S,
	args: Record<string, unknown>,
): z.infer<z.ZodObject<S>> {
	return z.object(shape).parse(args);
}

const MAX_BATCH_CREATE_TASKS = 50;
const MAX_BATCH_AGENT_SYSTEM_PROMPTS = 50;

async function buildMcpCreateTaskCaller(
	db: PGlite,
	auth: AuthInfo,
	teamId: string,
): Promise<CreateTaskCaller> {
	const actorMemberId = await resolveActorMemberId(db, auth, teamId);
	const caller: CreateTaskCaller = {
		actorType: actorTypeFromAuth(auth),
		actorMemberId,
		actorApiKeyId: apiKeyIdFromAuth(auth),
	};
	if (auth.type === AuthType.Agent) {
		caller.agentMemberId = auth.memberId;
		caller.runId = auth.runId ?? undefined;
	}
	return caller;
}

function mcpArgsToCreateTaskInput(
	args: Record<string, unknown>,
	projectId: string,
): CreateTaskInput {
	return {
		project_id: projectId,
		title: args.title as string,
		description: args.description as string | undefined,
		assignee_id: args.assignee_id as string | undefined,
		assignee_slug: args.assignee_slug as string | undefined,
		parent_task_id: args.parent_task_id as string | undefined,
		priority: args.priority as string | undefined,
		runtime_type: args.runtime_type as string | undefined,
		blocked_by_task_ids: args.blocked_by_task_ids as string[] | undefined,
		goal_id: args.goal_id as string | undefined,
	};
}

export interface ToolScope {
	projectId: string;
	teamId: string;
}

/**
 * Resolve the project a tool call targets, then authorize the caller for it.
 *
 * Hezo is project-centric: callers address resources by `project` (slug or UUID)
 * and the backing team is derived from it (1:1). When `project` is omitted the
 * call falls back to the caller's own run scope — a normal agent run passes
 * nothing and operates on its own project, while an instance principal (the CEO
 * chat session) names the project it wants to reach. `team_id` is never part of
 * the tool surface; it stays an internal key.
 */
export async function resolveScope(
	db: PGlite,
	auth: AuthInfo,
	args: Record<string, unknown>,
): Promise<ToolScope | { error: string }> {
	const raw =
		typeof args.project === 'string' && args.project.trim().length > 0 ? args.project.trim() : null;

	let scope: ToolScope | null = null;
	if (raw) {
		const p = await resolveProject(db, raw);
		if (!p) return { error: `Unknown project: ${raw}` };
		scope = { projectId: p.projectId, teamId: p.teamId };
	} else if (auth.type === AuthType.Agent) {
		scope = { projectId: auth.projectId, teamId: auth.teamId };
	} else {
		// Instance principals (an API key, the CEO chat session) have no home
		// project — they must name the project they want to act in.
		return { error: '`project` is required' };
	}

	const denied = await authorizeScope(db, auth, scope);
	if (denied) return { error: denied };
	return scope;
}

/** Authorize `auth` to act inside `scope`. Returns an error string, or null when allowed. */
async function authorizeScope(
	db: PGlite,
	auth: AuthInfo,
	scope: ToolScope,
): Promise<string | null> {
	switch (auth.type) {
		case AuthType.Agent:
			// Instance principals (CEO chat session / cross-project runs) roam every project.
			if (auth.crossProject || auth.crossTeam) return null;
			if (auth.projectId !== scope.projectId) {
				return 'Access denied: run is not scoped to this project';
			}
			return null;
		case AuthType.ApiKey:
			// Admin-equivalent: every project across the instance.
			return null;
		case AuthType.Admin: {
			if (auth.isSuperuser) return null;
			const r = await db.query(
				`SELECT 1 FROM members m JOIN member_users mu ON mu.id = m.id
				 WHERE mu.user_id = $1 AND m.team_id = $2`,
				[auth.userId, scope.teamId],
			);
			return r.rows.length > 0 ? null : 'Access denied: not a member of this project';
		}
		default:
			return 'Access denied';
	}
}

/**
 * Authorize `auth` for a team derived from a resource (e.g. an approval's team),
 * not from tool input. Used by the handful of tools keyed by a resource id whose
 * team is looked up server-side rather than passed in.
 */
async function authorizeTeam(db: PGlite, auth: AuthInfo, teamId: string): Promise<string | null> {
	switch (auth.type) {
		case AuthType.Agent:
			if (auth.crossTeam) return null;
			return auth.teamId === teamId ? null : 'Access denied: team mismatch';
		case AuthType.ApiKey:
			// Admin-equivalent: every team across the instance.
			return null;
		case AuthType.Admin: {
			if (auth.isSuperuser) return null;
			const r = await db.query(
				`SELECT 1 FROM members m JOIN member_users mu ON mu.id = m.id
				 WHERE mu.user_id = $1 AND m.team_id = $2`,
				[auth.userId, teamId],
			);
			return r.rows.length > 0 ? null : 'Access denied: not a member of this team';
		}
		default:
			return 'Access denied';
	}
}

/**
 * Resolve a tool call's project scope and its `task_id` argument (identifier or
 * UUID) together, verifying the task belongs to the resolved project.
 */
async function resolveTaskScope(
	db: PGlite,
	auth: AuthInfo,
	args: Record<string, unknown>,
): Promise<(ToolScope & { taskId: string }) | { error: string }> {
	const scope = await resolveScope(db, auth, args);
	if ('error' in scope) return scope;
	const raw = typeof args.task_id === 'string' ? args.task_id : '';
	if (!raw) return { error: 'task_id is required' };
	const taskId = await resolveTaskId(db, scope.teamId, raw);
	if (!taskId) return { error: `Task not found: ${raw}` };
	const r = await db.query<{ project_id: string }>(
		'SELECT project_id FROM tasks WHERE id = $1 AND team_id = $2',
		[taskId, scope.teamId],
	);
	if (r.rows.length === 0 || r.rows[0].project_id !== scope.projectId) {
		return { error: `Task not found in project: ${raw}` };
	}
	return { ...scope, taskId };
}

/** Standard schema entry for the optional `project` selector shared by project-scoped tools. */
const projectArg = () =>
	z
		.string()
		.optional()
		.describe(
			'Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in.',
		);

export function registerTools(
	server: McpServer,
	db: PGlite,
	dataDir: string,
	masterKeyManager: MasterKeyManager,
	wsManager?: WebSocketManager,
	events?: DomainEventBus,
	containerDeps?: ContainerDeps,
): ToolDef[] {
	registeredTools.length = 0;

	// Teams
	tool(
		server,
		'list_teams',
		'List teams accessible to the caller. An API key and the instance CEO (cross-team session) get every team in the instance; an ordinary agent run gets only its own team.',
		{},
		async (_args, db, auth) => {
			// The instance CEO chat session acts across every team (cross-team gated
			// at mint time), so it discovers the whole roster — not just HQ. An
			// approved API key is admin-equivalent and spans the instance too.
			if (auth.type === AuthType.ApiKey || (auth.type === AuthType.Agent && auth.crossTeam)) {
				const r = await db.query('SELECT * FROM teams ORDER BY name');
				return r.rows;
			}
			if (auth.type === AuthType.Agent) {
				const r = await db.query('SELECT * FROM teams WHERE id = $1', [auth.teamId]);
				return r.rows;
			}
			if (auth.type === AuthType.Admin) {
				if (auth.isSuperuser) {
					const r = await db.query('SELECT * FROM teams ORDER BY name');
					return r.rows;
				}
				const r = await db.query(
					`SELECT c.* FROM teams c
					 JOIN members m ON m.team_id = c.id
					 JOIN member_users mu ON mu.id = m.id
					 WHERE mu.user_id = $1
					 ORDER BY c.name`,
					[auth.userId],
				);
				return r.rows;
			}
			return [];
		},
		db,
	);

	tool(
		server,
		'get_team',
		'Get the team backing a project',
		{
			project: projectArg(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const r = await db.query('SELECT * FROM teams WHERE id = $1', [scope.teamId]);
			return r.rows[0] ?? null;
		},
		db,
	);

	tool(
		server,
		'create_team',
		'Create a new team (superuser only)',
		{
			name: z.string().describe('Team name'),
			description: z.string().optional().describe('Team description'),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Admin || !auth.isSuperuser) {
				return { error: 'Access denied: superuser required' };
			}
			const slug = (args.name as string)
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
			const r = await db.query(
				`INSERT INTO teams (name, slug, description) VALUES ($1, $2, $3) RETURNING *`,
				[args.name, slug, args.description ?? ''],
			);
			return r.rows[0];
		},
		db,
	);

	// Tasks
	tool(
		server,
		'list_tasks',
		"List a project's tasks. Returns up to 50 tasks ordered by creation date (newest first). Omit `project` to use the project your run is in; pass it (slug or ID) to inspect another project. Narrow with status (comma-separated) or assignee_id/assignee_slug. The Project State block in your system prompt already gives you the active tickets in the current project — only call this if you need older or terminal tickets, another project, or a specific status filter. Pass excerpt_chars (e.g. 300) to truncate description and rules to triage-sized excerpts; omit for full content.",
		{
			project: projectArg(),
			status: z.string().optional().describe('Filter by status (comma-separated)'),
			assignee_id: z.string().optional().describe('Filter by assignee member ID'),
			assignee_slug: z
				.string()
				.optional()
				.describe('Filter by assignee agent slug (alternative to assignee_id)'),
			excerpt_chars: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'When set, replaces description and rules with first-paragraph excerpts capped at this many characters, plus _truncated and _length companion fields',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const conditions = ['i.project_id = $1'];
			const params: unknown[] = [scope.projectId];
			let idx = 2;
			if (args.status) {
				const statuses = (args.status as string).split(',');
				const ph = statuses.map((_, i) => `$${idx + i}::task_status`).join(', ');
				conditions.push(`i.status IN (${ph})`);
				params.push(...statuses);
				idx += statuses.length;
			}
			let assigneeId = args.assignee_id as string | undefined;
			if (!assigneeId && args.assignee_slug) {
				const agent = await db.query<{ id: string }>(
					`SELECT ma.id FROM member_agents ma
					 JOIN members m ON m.id = ma.id
					 WHERE ma.slug = $1 AND m.team_id = $2`,
					[args.assignee_slug, scope.teamId],
				);
				if (agent.rows.length === 0) return [];
				assigneeId = agent.rows[0].id;
			}
			if (assigneeId) {
				conditions.push(`i.assignee_id = $${idx}`);
				params.push(assigneeId);
				idx++;
			}
			const r = await db.query(
				`SELECT ${TASK_COLUMNS}, p.name AS project_name
				 FROM tasks i JOIN projects p ON p.id = i.project_id
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY i.created_at DESC LIMIT 50`,
				params,
			);
			const max = args.excerpt_chars as number | undefined;
			if (max == null) return r.rows;
			return r.rows.map((row) => {
				let next = applyExcerpt(row as Record<string, unknown>, 'description', max);
				next = applyExcerpt(next, 'rules', max);
				return next;
			});
		},
		db,
	);

	tool(
		server,
		'get_task',
		"Get task details, including the ticket's declared blockers (upstream — what this ticket is waiting on) and dependents (downstream — tickets that are blocked on this one). Each entry has identifier, title, and current status. A non-empty blockers list means an automatic agent run on this ticket is paused until every blocker reaches a terminal status (done, cancelled). The dependents list shows which teammates' tickets will be auto-unblocked when this ticket is marked terminal — you do not need to @-mention them, the auto-wake handles it.",
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID'),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { taskId } = scope;
			const r = await db.query<Record<string, unknown> & { project_id: string }>(
				`SELECT ${TASK_COLUMNS_BARE} FROM tasks i WHERE i.id = $1`,
				[taskId],
			);
			const task = r.rows[0];
			if (!task) return null;
			const blockers = await db.query(
				`SELECT d.id AS dependency_id, b.id, b.identifier, b.title, b.status::text AS status
				 FROM task_dependencies d
				 JOIN tasks b ON b.id = d.blocked_by_task_id
				 WHERE d.task_id = $1
				 ORDER BY d.created_at ASC`,
				[taskId],
			);
			const dependents = await db.query(
				`SELECT d.id AS dependency_id, b.id, b.identifier, b.title, b.status::text AS status
				 FROM task_dependencies d
				 JOIN tasks b ON b.id = d.task_id
				 WHERE d.blocked_by_task_id = $1
				 ORDER BY d.created_at ASC`,
				[taskId],
			);
			return {
				...(task as Record<string, unknown>),
				blockers: blockers.rows,
				dependents: dependents.rows,
			};
		},
		db,
	);

	tool(
		server,
		'create_task',
		"Create a new task. Use parent_task_id for sub-tasks — prefer this over a top-level ticket whenever the new work is part of the ticket you are on. Sub-tasks themselves can have sub-tasks, but no deeper (depth is capped at 2). Use assignee_slug as alternative to assignee_id. As an agent caller, you may only assign to yourself or to your direct subordinates — to request work from anyone else (peers, your manager, or agents elsewhere in the org), use create_comment with @<agent-slug> on a relevant ticket instead. Use blocked_by_task_ids to declare prerequisites — the assignee will not be woken on this ticket until every blocker reaches a terminal status (done, cancelled). When splitting work into sequential phases, prefer create_tasks and chain the items with '#<index>' blockers instead of filing them unordered. In title/description, reference teammates with @<agent-slug>. Reference tickets and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug — no @ prefix. Do not wrap any of these in backticks — that makes them inert.",
		{
			project: projectArg(),
			title: z.string().describe('Task title'),
			description: z.string().optional().describe('Task description'),
			priority: z.string().optional().describe('Priority: low, medium, high, urgent'),
			assignee_id: z.string().optional().describe('Assignee member ID'),
			assignee_slug: z
				.string()
				.optional()
				.describe('Assignee agent slug (alternative to assignee_id)'),
			parent_task_id: z
				.string()
				.optional()
				.describe(
					'Parent task to nest this under as a sub-task — a task identifier (e.g. "BE-2") or UUID. Sub-tasks can themselves have sub-tasks, but no deeper — depth is capped at 2.',
				),
			runtime_type: z
				.string()
				.optional()
				.describe(
					'Pin this task to a specific AI runtime (claude_code, codex, gemini). Leave unset to use the instance default.',
				),
			blocked_by_task_ids: z
				.array(z.string())
				.optional()
				.describe(
					'Task identifiers (e.g. ["BE-2", "BE-3"]) or UUIDs that must reach a terminal status before this ticket is started. The assignee will not be woken on this ticket until every blocker is satisfied.',
				),
			goal_id: z
				.string()
				.optional()
				.describe(
					'UUID of the project goal this task advances. Links the task to the goal for traceability; it does not gate or change how the task runs. (Captain) set this when filing work to move a goal forward.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const caller = await buildMcpCreateTaskCaller(db, auth, scope.teamId);
			let created: Awaited<ReturnType<typeof createTask>>;
			try {
				created = await createTask(
					db,
					scope.teamId,
					mcpArgsToCreateTaskInput(args, scope.projectId),
					caller,
					wsManager,
					events,
				);
			} catch (e) {
				if (e instanceof CreateTaskError) return { error: e.message };
				throw e;
			}
			return withBacktickWarning(
				db,
				auth,
				scope.teamId,
				scope.projectId,
				args.description as string | undefined,
				created,
			);
		},
		db,
	);

	tool(
		server,
		'list_goals',
		"List a project's goals (the objectives the Captain tracks). Each goal has a title, a `measurement` (the precise definition of when the goal is achieved — the bar to judge against), optional `actions` (admin guidance on what to do/check toward it), the Captain's current progress_percent (0-100), a health (pending/on_track/at_risk/off_track), a status_blurb, a check_frequency (daily/weekly/monthly), an optional target_date (deadline), and last_checked_at. As the Captain, call this during your heartbeat to see which goals are due for a fresh assessment, then call update_goal_progress for each. Archived goals are excluded unless include_archived is true.",
		{
			project: projectArg(),
			include_archived: z.boolean().optional().describe('Include archived goals (default false).'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			return listGoals(db, scope.projectId, {
				includeArchived: args.include_archived === true,
			});
		},
		db,
	);

	tool(
		server,
		'update_goal_progress',
		"Record your current assessment of a goal's progress. Only the Captain does this, and only from within a progress-update run. Pass progress_percent (0-100, your honest estimate — do not lower it without a reason in the blurb), health (on_track / at_risk / off_track, weighing progress against the target_date), and a one-paragraph status_blurb explaining where the goal stands and what is needed next. This updates the goal's live status and appends a point to its progress history; the goal then won't be re-surfaced for checking until its cadence elapses again.",
		{
			project: projectArg(),
			goal_id: z.string().describe('UUID of the goal to update.'),
			progress_percent: z
				.number()
				.int()
				.min(0)
				.max(100)
				.describe('Estimated progress toward the goal, 0-100.'),
			health: z.enum(CAPTAIN_SETTABLE_GOAL_HEALTH).describe('on_track, at_risk, or off_track.'),
			status_blurb: z
				.string()
				.describe('One-paragraph summary of where the goal stands and the next step.'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			if (auth.type !== AuthType.Agent || !auth.runId) {
				return { error: 'update_goal_progress can only be called from within an agent run' };
			}
			const goalId = args.goal_id as string;
			const found = await db.query<{ id: string }>(
				`SELECT id FROM goals WHERE id = $1 AND project_id = $2 AND archived_at IS NULL`,
				[goalId, scope.projectId],
			);
			if (found.rows.length === 0) {
				return { error: `Goal not found in project: ${goalId}` };
			}
			try {
				return await recordGoalProgress(
					db,
					{
						goalId,
						runId: auth.runId,
						progressPercent: args.progress_percent as number,
						health: args.health as GoalHealth,
						statusBlurb: args.status_blurb as string,
					},
					wsManager,
				);
			} catch (e) {
				if (e instanceof Error && 'code' in e) return { error: e.message };
				throw e;
			}
		},
		db,
	);

	tool(
		server,
		'update_project_progress',
		"Replace the project's progress summary shown at the top of the Progress page. Only the Captain does this, and only from within a progress-update run. Keep it a concise summary, not a backlog: lead with the key points in **bold**, then a short narrative of what is done, what is in progress, and what is still to do. You may reference a few of the most relevant tickets by their bare identifier (e.g. BE-2) — link sparingly. This overwrites the whole summary, so include everything that should remain.",
		{
			project: projectArg(),
			summary: z
				.string()
				.describe(
					'Markdown summary of project progress. Lead with the key points in **bold**, then a short narrative of done / in-progress / to-do. Link only a few key tickets by identifier; keep it a summary.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			if (auth.type !== AuthType.Agent || !auth.runId) {
				return { error: 'update_project_progress can only be called from within an agent run' };
			}
			try {
				return await updateProjectProgress(
					db,
					scope.teamId,
					scope.projectId,
					args.summary as string,
					wsManager,
				);
			} catch (e) {
				if (e instanceof ProjectProgressError) return { error: e.message };
				throw e;
			}
		},
		db,
	);

	tool(
		server,
		'create_tasks',
		`Create multiple tasks in one call (max ${MAX_BATCH_CREATE_TASKS}). Items are created in order; each has the same shape as create_task, and per-item errors are returned without aborting the rest. Within a batch, blocked_by_task_ids entries may reference an earlier item in the same call by zero-based index token — '#0' is the first item. To chain sequential work (e.g. implementation phases that must run one at a time), set blocked_by_task_ids: ['#<previous index>'] on every item after the first; each task then stays blocked until the one before it reaches a terminal status. Filing sequential phases WITHOUT these blockers makes all of them runnable at once. Index tokens may only point at earlier items; a token that is self-referencing, forward-referencing, or points at an item that failed errors that item. Use this when filing a related set of tickets in one go (planning a feature, splitting a ticket into phases or sub-tasks). For a single task, use create_task.`,
		{
			project: projectArg(),
			items: z
				.array(
					z.object({
						title: z.string().describe('Task title'),
						description: z.string().optional().describe('Task description'),
						priority: z.string().optional().describe('Priority: low, medium, high, urgent'),
						assignee_id: z.string().optional().describe('Assignee member ID'),
						assignee_slug: z
							.string()
							.optional()
							.describe('Assignee agent slug (alternative to assignee_id)'),
						parent_task_id: z
							.string()
							.optional()
							.describe(
								'Parent task to nest this under as a sub-task — a task identifier (e.g. "BE-2"), UUID, or a zero-based index token referencing an earlier item in this same call (e.g. "#0" = first item). Sub-tasks can themselves have sub-tasks, but no deeper — depth is capped at 2.',
							),
						runtime_type: z
							.string()
							.optional()
							.describe(
								'Pin this task to a specific AI runtime (claude_code, codex, gemini). Leave unset to use the instance default.',
							),
						blocked_by_task_ids: z
							.array(z.string())
							.optional()
							.describe(
								'Task identifiers (e.g. ["BE-2"]), UUIDs, or zero-based index tokens referencing earlier items in this same call (e.g. "#0" = first item). All must reach a terminal status before this ticket starts. To chain phases sequentially, set ["#<previous index>"] on each item after the first.',
							),
					}),
				)
				.min(1)
				.max(MAX_BATCH_CREATE_TASKS)
				.describe(`Up to ${MAX_BATCH_CREATE_TASKS} items.`),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const items = args.items as Array<Record<string, unknown>>;
			const caller = await buildMcpCreateTaskCaller(db, auth, scope.teamId);

			const results = await createTaskBatch(
				db,
				scope.teamId,
				items.map((item) => mcpArgsToCreateTaskInput(item, scope.projectId)),
				caller,
				wsManager,
				events,
			);
			if (auth.type !== AuthType.Agent) return results;
			// Per-item advisory: flag a created task whose own description backticked
			// a real entity. Keyed by the result index back to the source item.
			return Promise.all(
				results.map(async (r) => {
					if (!r.ok) return r;
					const description = items[r.index]?.description;
					const task = await withBacktickWarning(
						db,
						auth,
						scope.teamId,
						scope.projectId,
						typeof description === 'string' ? description : undefined,
						r.task,
					);
					return { ...r, task };
				}),
			);
		},
		db,
	);

	tool(
		server,
		'update_task',
		'Update an task. Agents can use this to change status, update progress, set rules, and record branch names. To finish a ticket, set status to `done` — that is the final completed state and wakes Coach to review the ticket for prompt-learning (the task stays `done`). Use `cancelled` for abandoned work. Setting `done` is rejected for agent callers while the task has an @admin question no human has answered yet — keep the task `in_progress` or move it to `review` until the admin replies. Re-opening a completed task (`done`/`cancelled`) is admin-only. As an agent caller, reassigning is limited to yourself or your direct subordinates; to hand work to a peer or manager use create_comment with @<agent-slug> instead. In description, progress_summary, and rules, reference teammates with @<agent-slug>. Reference tickets and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug — no @ prefix. Do not wrap any of these in backticks — that makes them inert.',
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID'),
			title: z.string().optional().describe('New title'),
			description: z.string().optional().describe('New description'),
			status: z
				.string()
				.optional()
				.describe(
					'New status (backlog, in_progress, review, blocked, done, cancelled). `done` = completed (final); marking a ticket `done` wakes Coach to review it for prompt-learning but leaves it `done`. `cancelled` = abandoned. Re-opening a completed task (done/cancelled) is admin-only.',
				),
			priority: z.string().optional().describe('New priority'),
			assignee_id: z.string().optional().describe('New assignee ID'),
			progress_summary: z.string().optional().describe('Progress summary update'),
			rules: z
				.string()
				.optional()
				.describe(
					'How-to-work-on guardrails for this ticket — approach constraints that shape execution (e.g. "run tests before committing", "consult the architect before auth changes"). Not a channel for passing project domain knowledge to other agents; put that in description instead.',
				),
			branch_name: z.string().optional().describe('Git branch name for this task'),
			runtime_type: z
				.string()
				.optional()
				.describe(
					'Override the AI runtime for this task (claude_code, codex, gemini). Pass an empty string to clear.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;

			const currentRowResult = await db.query<{
				status: string;
				assignee_id: string | null;
			}>('SELECT status, assignee_id FROM tasks WHERE id = $1', [taskId]);
			const currentRow = currentRowResult.rows[0];

			const scopeDenied = assertRunTaskScope(auth, taskId, args.status as string | undefined);
			if (scopeDenied) return { error: scopeDenied };

			const currentStatus = currentRow?.status;
			const previousAssigneeId = currentRow?.assignee_id ?? null;

			// `done` and `cancelled` are the only terminal states; once a task is
			// terminal only the admin can re-open it (move it back to active).
			if (
				args.status !== undefined &&
				args.status !== currentStatus &&
				auth.type === AuthType.Agent &&
				(TERMINAL_TASK_STATUSES as readonly string[]).includes(currentStatus ?? '')
			) {
				return { error: 'Only the admin can re-open a completed task' };
			}

			if (args.status === TaskStatus.Done) {
				const childrenCheck = await assertChildrenAllClosed(db, teamId, taskId);
				if (!childrenCheck.ok) return { error: childrenCheck.message };
			}
			if (args.status === TaskStatus.Done) {
				const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
				const activityCheck = await assertNoOutstandingActivity(db, taskId, callerMemberId);
				if (!activityCheck.ok) return { error: activityCheck.message };
				// Agents cannot close over an unanswered @admin ask; humans (and
				// API keys — admin-equivalent) can always close through it.
				if (callerMemberId !== null) {
					const adminAskCheck = await assertNoUnansweredAdminMentions(db, taskId);
					if (!adminAskCheck.ok) return { error: adminAskCheck.message };
				}
			}

			if (args.status !== undefined) {
				args.status = await coerceTargetStatusForBlockers(db, taskId, args.status as string);
			}

			if (args.assignee_id && currentRow) {
				if (args.assignee_id !== previousAssigneeId) {
					const activeRunCheck = await assertNoActiveRun(db, taskId);
					if (!activeRunCheck.ok) return { error: activeRunCheck.message };
				}
				if (auth.type === AuthType.Agent && args.assignee_id !== previousAssigneeId) {
					const hierarchyCheck = await assertSubordinateAssignee(
						db,
						auth.memberId,
						args.assignee_id as string,
					);
					if (!hierarchyCheck.ok) return { error: hierarchyCheck.message };
				}
			}

			const sets: string[] = [];
			const params: unknown[] = [];
			let idx = 1;
			for (const [key, val] of Object.entries(args)) {
				if (['project', 'task_id'].includes(key) || val === undefined) continue;
				if (key === 'status') {
					sets.push(`status = $${idx}::task_status`);
				} else if (key === 'priority') {
					sets.push(`priority = $${idx}::task_priority`);
				} else if (key === 'runtime_type') {
					sets.push(`runtime_type = $${idx}::agent_runtime`);
					params.push(val === '' ? null : val);
					idx++;
					continue;
				} else if (key === 'progress_summary') {
					sets.push(`progress_summary = $${idx}`);
					params.push(val);
					idx++;
					sets.push('progress_summary_updated_at = now()');
					const updatedBy = auth.type === AuthType.Agent ? auth.memberId : null;
					sets.push(`progress_summary_updated_by = $${idx}`);
					params.push(updatedBy);
					idx++;
					continue;
				} else {
					sets.push(`${key} = $${idx}`);
				}
				params.push(val);
				idx++;
			}
			if (sets.length === 0) return { unchanged: true };
			params.push(taskId);
			const r = await db.query(
				`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${TASK_COLUMNS_BARE}`,
				params,
			);
			if (!r.rows[0]) return null;

			const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const actorApiKeyId = apiKeyIdFromAuth(auth);

			if (args.description !== undefined) {
				trackBackground(
					recordTaskLinks(
						db,
						teamId,
						taskId,
						args.description as string,
						actorMemberId,
						actorApiKeyId,
						wsManager,
					).catch((e) => log.error('Failed to record task links from description:', e)),
				);
			}

			if (args.status && currentStatus) {
				try {
					await triggerStatusAutomations(
						db,
						teamId,
						taskId,
						currentStatus,
						args.status as string,
						actorMemberId,
						actorApiKeyId,
						wsManager,
					);
				} catch (e) {
					log.error('Failed to trigger status automations:', e);
				}
			}

			if (args.assignee_id && args.assignee_id !== previousAssigneeId) {
				const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [
					args.assignee_id,
				]);
				if (isAgent.rows.length > 0) {
					trackBackground(
						createWakeup(db, args.assignee_id as string, teamId, WakeupSource.Assignment, {
							task_id: taskId,
						}).catch((e) => log.error('Failed to wake agent:', e)),
					);
				}
			}

			const updatedText = [args.description, args.progress_summary, args.rules]
				.filter((v): v is string => typeof v === 'string')
				.join('\n');
			return withBacktickWarning(
				db,
				auth,
				teamId,
				scope.projectId,
				updatedText || undefined,
				r.rows[0],
			);
		},
		db,
	);

	tool(
		server,
		'add_task_blocker',
		'Declare that one task blocks another. The downstream ticket will not start an automatic agent run until the blocker reaches a terminal status (done, cancelled). Use this when you discover that a ticket you have been woken on depends on work that has not landed yet — declare the blocker and end your turn; the system will wake you again when the blocker resolves. Cycles are rejected.',
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID that should be blocked'),
			blocked_by_task_id: z.string().describe('Task identifier or UUID of the upstream blocker'),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			const blockerId = await resolveTaskId(db, teamId, args.blocked_by_task_id as string);
			if (!blockerId) return { error: 'Blocking task not found in this project' };
			if (blockerId === taskId) return { error: 'A task cannot block itself' };
			if (await wouldCreateCycle(db, taskId, blockerId)) {
				return { error: 'Dependency would create a cycle' };
			}
			const r = await db.query(
				`INSERT INTO task_dependencies (task_id, blocked_by_task_id)
				 VALUES ($1, $2) ON CONFLICT DO NOTHING
				 RETURNING id, task_id, blocked_by_task_id, created_at`,
				[taskId, blockerId],
			);
			if (r.rows.length === 0) return { error: 'Dependency already exists' };
			const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			await reconcileBlockedStatus(db, teamId, taskId, actorMemberId, wsManager);
			return r.rows[0];
		},
		db,
	);

	tool(
		server,
		'remove_task_blocker',
		"Remove a blocker between two tasks. Call this when a dependency that was previously declared no longer applies. If removing this dependency clears the downstream ticket's last open blocker, its assignee is woken automatically.",
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID that is currently blocked'),
			blocked_by_task_id: z.string().describe('Task identifier or UUID of the blocker to remove'),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			const blockerId = await resolveTaskId(db, teamId, args.blocked_by_task_id as string);
			if (!blockerId) return { error: 'Blocking task not found' };
			const r = await db.query(
				'DELETE FROM task_dependencies WHERE task_id = $1 AND blocked_by_task_id = $2 RETURNING id',
				[taskId, blockerId],
			);
			if (r.rows.length === 0) return { error: 'Dependency not found' };
			const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			await reconcileBlockedStatus(db, teamId, taskId, actorMemberId, wsManager);
			await wakeIfReady(db, taskId);
			return { removed: true };
		},
		db,
	);

	// Agents
	tool(
		server,
		'list_agents',
		"List the agents on a project's team",
		{
			project: projectArg(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const r = await db.query(
				`SELECT m.id, ma.agent_type_id, ma.title, ma.slug,
				        ma.daily_budget_cents, ma.weekly_budget_cents, ma.monthly_budget_cents,
				        ma.runtime_status, ma.admin_status
				 FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.team_id = $1 ORDER BY ma.title`,
				[scope.teamId],
			);
			return r.rows;
		},
		db,
	);

	tool(
		server,
		'update_hire_proposal',
		'Revise the draft of a pending hire approval. Captain-only. Use this to expand or rewrite the system prompt, adjust role description, budget, heartbeat, or touches_code before admin review. All fields are optional — pass only what you want to change.',
		{
			approval_id: z.string().describe('Hire approval ID'),
			title: z.string().optional().describe('Updated role title'),
			role_description: z.string().optional().describe('Updated short role description'),
			system_prompt: z
				.string()
				.optional()
				.describe(
					`Updated system prompt. If provided, it must keep every required substitution variable (${REQUIRED_SYSTEM_PROMPT_VARS.join(', ')}) or the revision is rejected.`,
				),
			reports_to: z
				.string()
				.optional()
				.describe(
					"Updated manager — an existing agent's slug. Pass an empty string to clear the reporting line.",
				),
			default_effort: z
				.string()
				.optional()
				.describe('Updated default effort: minimal, low, medium, high, max'),
			heartbeat_interval_min: z.number().optional().describe('Updated heartbeat interval (min)'),
			monthly_budget_cents: z.number().optional().describe('Updated monthly budget in cents'),
			touches_code: z.boolean().optional().describe('Whether this agent reads/writes repo code'),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent) {
				return { error: 'update_hire_proposal is only callable by agents' };
			}
			const caller = await db.query<{ slug: string }>(
				'SELECT slug FROM member_agents WHERE id = $1',
				[auth.memberId],
			);
			if (caller.rows[0]?.slug !== CAPTAIN_AGENT_SLUG) {
				return { error: 'Only the Captain can revise hire proposals' };
			}

			const approval = await db.query<{
				id: string;
				team_id: string;
				type: string;
				status: string;
				payload: Record<string, unknown>;
			}>('SELECT id, team_id, type, status, payload FROM approvals WHERE id = $1', [
				args.approval_id,
			]);
			if (approval.rows.length === 0) return { error: 'Approval not found' };

			const row = approval.rows[0];
			if (row.team_id !== auth.teamId) {
				return { error: 'Access denied: team mismatch' };
			}
			if (row.type !== ApprovalType.Hire) {
				return { error: 'Approval is not a hire request' };
			}
			if (row.status !== ApprovalStatus.Pending) {
				return { error: 'Hire approval is already resolved' };
			}

			// A revised system prompt must keep the required substitution variables.
			if (typeof args.system_prompt === 'string' && args.system_prompt.trim()) {
				const promptError = requiredSystemPromptVarsError(args.system_prompt);
				if (promptError) return { error: promptError };
			}

			// A revised manager must resolve to an agent on this team (empty clears it).
			if (typeof args.reports_to === 'string' && args.reports_to.trim()) {
				const raw = args.reports_to.trim();
				if (raw === row.payload.slug) {
					return { error: 'reports_to: an agent cannot report to itself' };
				}
				const managerId = await resolveAgentId(db, row.team_id, raw);
				if (!managerId) return { error: `reports_to: no agent '${raw}' in this team` };
			}

			const patch = buildHirePayloadPatch(args as HirePayloadPatchInput);

			if (Object.keys(patch).length === 0) {
				return { error: 'no fields to update' };
			}

			const updated = await db.query<Record<string, unknown>>(
				`UPDATE approvals SET payload = payload || $1::jsonb
				 WHERE id = $2 RETURNING ${APPROVAL_COLUMNS}`,
				[JSON.stringify(patch), args.approval_id],
			);
			return updated.rows[0] ?? null;
		},
		db,
	);

	tool(
		server,
		'create_hire_proposal',
		'File a new hire proposal. Callable by a team Captain (for its own team) or the CEO (for any team — pass `project` to target it, including HQ). Use this when directed or deciding to staff or expand a team: author the full role spec — title, role description, and a complete system prompt — and submit it. The proposal surfaces as a pending approval in the admin inbox; the admin reviews, may modify it, and approves, at which point the agent is created automatically. Pass task_id to link the proposal back to the ticket that prompted it.',
		{
			project: projectArg(),
			title: z.string().describe('Role title (the slug is derived from it)'),
			role_description: z.string().optional().describe('Short role description'),
			system_prompt: z
				.string()
				.optional()
				.describe(
					`Full system prompt for the new agent. If provided, it MUST contain every required substitution variable (${REQUIRED_SYSTEM_PROMPT_VARS.join(', ')}) or the proposal is rejected — these inject the agent's identity, manager, and live skills/docs/preferences context. Author it in the style of the built-in role docs.`,
				),
			reports_to: z
				.string()
				.optional()
				.describe(
					'The manager this agent reports to — an existing agent\'s slug (e.g. "architect"). Sets the structural reporting line so work can be delegated to and from this agent. Must be an agent already on the team.',
				),
			default_effort: z
				.string()
				.optional()
				.describe('Default reasoning effort: minimal, low, medium, high, max'),
			heartbeat_interval_min: z.number().optional().describe('Heartbeat interval (min)'),
			daily_budget_cents: z.number().optional().describe('Daily budget in cents'),
			weekly_budget_cents: z.number().optional().describe('Weekly budget in cents'),
			monthly_budget_cents: z.number().optional().describe('Monthly budget in cents'),
			touches_code: z.boolean().optional().describe('Whether this agent reads/writes repo code'),
			task_id: z
				.string()
				.optional()
				.describe(
					'Optional originating ticket to link the proposal to — a task identifier (e.g. "HM-1") or UUID',
				),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent) {
				return { error: 'create_hire_proposal is only callable by agents' };
			}
			const caller = await db.query<{ slug: string }>(
				'SELECT slug FROM member_agents WHERE id = $1',
				[auth.memberId],
			);
			const callerSlug = caller.rows[0]?.slug;
			if (callerSlug !== CAPTAIN_AGENT_SLUG && callerSlug !== CEO_AGENT_SLUG) {
				return { error: 'Only the Captain or CEO can create hire proposals' };
			}

			// The team is derived from scope: the Captain operates on its own team,
			// the CEO targets any team by passing `project`.
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const teamId = scope.teamId;

			let taskId: string | null = null;
			if (args.task_id !== undefined) {
				// Agents naturally hold the human-readable identifier (e.g. "HM-1"),
				// not the UUID — resolve either form before linking.
				const resolved = await resolveTaskId(db, teamId, args.task_id as string);
				// resolveTaskId trusts a well-formed UUID without a team check, so
				// re-verify the resolved task actually belongs to this team.
				const taskCheck = resolved
					? await db.query<{ id: string }>('SELECT id FROM tasks WHERE id = $1 AND team_id = $2', [
							resolved,
							teamId,
						])
					: null;
				if (!resolved || !taskCheck || taskCheck.rows.length === 0) {
					return { error: 'task_id not found on this team' };
				}
				taskId = resolved;
			}

			const prepared = await prepareHireProposal(db, teamId, args as unknown as HireProposalInput);
			if ('error' in prepared) return { error: prepared.error };

			const row = await insertHireApproval(db, teamId, prepared.payload, auth.memberId, taskId);
			broadcastApprovalChange(wsManager, teamId, 'INSERT', row);
			// Surface the proposal as a comment on the originating ticket so it shows in
			// the task thread (not just the admin inbox) and flips to hired/denied later.
			if (taskId) {
				await insertHireProposalComment(
					db,
					{
						taskId,
						approvalId: row.id as string,
						payload: prepared.payload as unknown as Record<string, unknown>,
						teamId,
						projectId: scope.projectId,
					},
					wsManager,
				);
			}
			return { approval_id: row.id, status: row.status, payload: row.payload };
		},
		db,
	);

	const createProjectShape = {
		name: z.string().trim().min(1, 'name is required').describe('Project name'),
		description: z
			.string()
			.trim()
			.min(1, 'description is required')
			.describe('Project description'),
		task_prefix: z
			.string()
			.optional()
			.describe('Optional 2-4 char uppercase ticket prefix; derived from the name when omitted'),
		initial_project_plan: z
			.string()
			.optional()
			.describe('Optional project plan document (markdown), seeded as project-plan.md'),
		template_id: z
			.string()
			.optional()
			.describe(
				'Team-type template id (from list_team_templates). Mutually exclusive with source_team_id; defaults to Blank when neither is given.',
			),
		source_team_id: z
			.string()
			.optional()
			.describe(
				'Existing team to clone into a fresh template. Mutually exclusive with template_id.',
			),
		intake_task_id: z
			.string()
			.optional()
			.describe(
				'The HQ project-intake ticket this fulfils; it is closed with a completion note on success.',
			),
	} satisfies z.ZodRawShape;
	tool(
		server,
		'create_project',
		'Create a new project together with its dedicated team. CEO-only. Call this ONLY after the admin has explicitly approved the finalised scope AND team type in the intake conversation — a plain reply approving it is enough (there is no inbox button to wait on), but do not call it while still scoping, on assumed defaults, or in the same turn you propose the plan; creating a project stands up a full team + container, so wait for the go-ahead. Provisions the team from the chosen team-type template (pass template_id from list_team_templates, or source_team_id to clone an existing team; defaults to Blank), creates the project, its planning ticket, and the initial CEO coherence/setup ticket the planning ticket is blocked on, then provisions the container. The coherence/setup ticket is created unassigned and does NOT start automatically on this path: first author its description (update_task on the returned coherence_task_identifier) to capture the concrete setup you agreed in intake — the exact roles to hire, any system-prompt rewrites, and the reporting structure — then call start_team_setup(project) to begin the run. When intake_task_id is given, the intake conversation is closed with a completion note. Returns the new project plus its planning and coherence ticket identifiers.',
		createProjectShape,
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent) {
				return { error: 'create_project is only callable by agents' };
			}
			const caller = await db.query<{ slug: string }>(
				'SELECT slug FROM member_agents WHERE id = $1',
				[auth.memberId],
			);
			if (caller.rows[0]?.slug !== CEO_AGENT_SLUG) {
				return { error: 'Only the CEO can create projects' };
			}

			// The SDK validated args against createProjectShape, so name/description
			// are already trimmed, non-empty strings (`.trim().min(1)`) and optionals
			// are `string | undefined` — no per-field ternaries or empty-checks here.
			const input = typedArgs(createProjectShape, args);
			const { name, description } = input;
			if (!containerDeps) {
				return { error: 'Project creation is not available in this context' };
			}

			// Idempotency: if this fulfils an intake ticket, that ticket must still be
			// open — otherwise a re-run (e.g. after a timeout) would create a second
			// project + team. Check before creating anything.
			const intakeTaskId = input.intake_task_id?.trim() || undefined;
			let intakeTeamId: string | undefined;
			if (intakeTaskId) {
				const intake = await db.query<{ status: string; team_id: string }>(
					'SELECT status::text AS status, team_id FROM tasks WHERE id = $1',
					[intakeTaskId],
				);
				if (intake.rows.length === 0) return { error: 'Intake task not found' };
				if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(intake.rows[0].status)) {
					return { error: 'This intake has already been completed' };
				}
				intakeTeamId = intake.rows[0].team_id;
			}

			const result = await createProjectWithTeam(
				containerDeps,
				{
					name,
					description,
					templateId: input.template_id,
					sourceTeamId: input.source_team_id,
					taskPrefix: input.task_prefix,
					initialProjectPlan: input.initial_project_plan ?? null,
					actorType: 'agent',
					actorMemberId: auth.memberId,
					// CEO-created: the coherence/setup ticket is created unassigned and
					// does NOT auto-run. The CEO drafts its description with the intake
					// plan, then calls start_team_setup to begin the run.
					suppressCoherenceAutoStart: true,
				},
				{ events },
			);
			if (!result.ok) return { error: result.message };

			const { project, planningTask, team, coherenceTask } = result;

			if (intakeTaskId) {
				const completed = await completeProjectIntakeAfterProvisioning(
					db,
					intakeTaskId,
					name,
					project.slug as string,
					wsManager,
				);
				if (wsManager && intakeTeamId) {
					const room = wsRoom.team(intakeTeamId);
					if (completed.summaryComment) {
						broadcastRowChange(
							wsManager,
							room,
							'task_comments',
							'INSERT',
							completed.summaryComment,
						);
					}
					if (completed.task) {
						broadcastRowChange(wsManager, room, 'tasks', 'UPDATE', completed.task);
					}
				}
			}

			return {
				...project,
				team_slug: team.slug,
				planning_task_id: planningTask.id,
				planning_task_identifier: planningTask.identifier,
				coherence_task_id: coherenceTask?.id ?? null,
				coherence_task_identifier: coherenceTask?.identifier ?? null,
			};
		},
		db,
	);

	tool(
		server,
		'start_team_setup',
		'Kick off the initial team-coherence/setup run for a project you created via create_project. ' +
			'CEO-only. Projects created directly from the admin form start their coherence pass automatically; ' +
			'projects you create do NOT. First author the coherence ticket with update_task — replace its ' +
			'description with the concrete plan you agreed in intake (the exact roles to hire and why, any ' +
			'system-prompt rewrites, and the reporting structure) — then call this to assign the ticket to ' +
			'yourself and start the run. Returns the started ticket; errors if there is no open setup ticket ' +
			'for the project or a run is already active on it.',
		{ project: projectArg() },
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent) {
				return { error: 'start_team_setup is only callable by agents' };
			}
			const caller = await db.query<{ slug: string }>(
				'SELECT slug FROM member_agents WHERE id = $1',
				[auth.memberId],
			);
			if (caller.rows[0]?.slug !== CEO_AGENT_SLUG) {
				return { error: 'Only the CEO can start team setup' };
			}

			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const placeholders = TERMINAL_TASK_STATUSES.map((_, i) => `$${i + 2}::task_status`).join(
				', ',
			);
			const ticket = await db.query<{
				id: string;
				identifier: string;
				assignee_id: string | null;
			}>(
				`SELECT id, identifier, assignee_id FROM tasks
				 WHERE team_id = $1
				   AND labels @> '["team-coherence-review"]'::jsonb
				   AND status NOT IN (${placeholders})
				 LIMIT 1`,
				[scope.teamId, ...TERMINAL_TASK_STATUSES],
			);
			const row = ticket.rows[0];
			if (!row) return { error: 'No open team-setup ticket for this project' };

			const active = await assertNoActiveRun(db, row.id);
			if (!active.ok) return { error: active.message };

			if (row.assignee_id !== auth.memberId) {
				const updated = await db.query<Record<string, unknown>>(
					`UPDATE tasks SET assignee_id = $1, updated_at = now() WHERE id = $2 RETURNING ${TASK_COLUMNS_BARE}`,
					[auth.memberId, row.id],
				);
				if (wsManager && updated.rows[0]) {
					broadcastRowChange(
						wsManager,
						wsRoom.team(scope.teamId),
						'tasks',
						'UPDATE',
						updated.rows[0],
					);
				}
			}

			await createWakeup(db, auth.memberId, scope.teamId, WakeupSource.Assignment, {
				task_id: row.id,
			});

			return { started: true, task_id: row.id, task_identifier: row.identifier };
		},
		db,
	);

	tool(
		server,
		'list_team_templates',
		'List team templates (built-in Startup for software development, Blank, and custom). Use when recommending a team structure to hire.',
		{},
		async (_args, db) => {
			const r = await db.query<{
				id: string;
				name: string;
				description: string;
				is_builtin: boolean;
				agent_types: Array<{ slug: string; name: string; role_description: string }>;
			}>(
				`SELECT ct.id, ct.name, ct.description, ct.is_builtin,
				    COALESCE(
				        json_agg(json_build_object(
				            'slug', at.slug,
				            'name', at.name,
				            'role_description', at.role_description
				        ) ORDER BY ctat.sort_order) FILTER (WHERE at.id IS NOT NULL),
				        '[]'
				    ) AS agent_types
				 FROM team_templates ct
				 LEFT JOIN team_template_agent_types ctat ON ctat.team_template_id = ct.id
				 LEFT JOIN agent_types at ON at.id = ctat.agent_type_id
				 GROUP BY ct.id
				 ORDER BY ct.is_builtin DESC, ct.name ASC`,
			);
			return r.rows;
		},
		db,
	);

	// Projects
	tool(
		server,
		'list_projects',
		'List projects. With CEO cross-team access (or as superuser) returns every project across the instance; a board user gets the projects on teams they belong to; an agent run gets its own project. Pass excerpt_chars (e.g. 300) to truncate description; omit for full content.',
		{
			excerpt_chars: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('When set, truncates description and adds description_truncated/_length'),
		},
		async (args, db, auth) => {
			const max = args.excerpt_chars as number | undefined;
			const withExcerpt = (rows: Record<string, unknown>[]) =>
				max == null ? rows : rows.map((row) => applyExcerpt(row, 'description', max));

			const instanceWide =
				(auth.type === AuthType.Agent && auth.crossTeam) ||
				(auth.type === AuthType.Admin && auth.isSuperuser) ||
				auth.type === AuthType.ApiKey;
			if (instanceWide) {
				const r = await db.query<Record<string, unknown>>(
					`SELECT p.id, p.team_id,
					        p.name, p.slug, p.task_prefix, p.description, p.is_internal,
					        p.created_at, p.updated_at
					 FROM projects p
					 ORDER BY p.name`,
				);
				return withExcerpt(r.rows);
			}

			if (auth.type === AuthType.Admin) {
				const r = await db.query<Record<string, unknown>>(
					`SELECT DISTINCT p.id, p.team_id,
					        p.name, p.slug, p.task_prefix, p.description, p.is_internal,
					        p.created_at, p.updated_at
					 FROM projects p
					 JOIN members m ON m.team_id = p.team_id
					 JOIN member_users mu ON mu.id = m.id
					 WHERE mu.user_id = $1
					 ORDER BY p.name`,
					[auth.userId],
				);
				return withExcerpt(r.rows);
			}

			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const r = await db.query<Record<string, unknown>>(
				`SELECT id, team_id, name, slug, task_prefix, description, is_internal, created_at, updated_at
				 FROM projects WHERE id = $1`,
				[scope.projectId],
			);
			return withExcerpt(r.rows);
		},
		db,
	);

	// Comments
	tool(
		server,
		'list_comments',
		"List comments for an task. Returns up to 50 most-recent comments (newest first). Pass before (a comment ID) to walk older. Pass excerpt_chars (e.g. 500) to truncate long text comments; structured comments (system/option/task_link) are always returned whole. Each row includes parent_comment_id (UUID or null) so you can see reply threading — when you reply substantively to a comment, pass that comment's id back as parent_comment_id in create_comment. Each row also has a public_id (a creation-timestamp slug like 20261009112345); that's how you cite a specific comment elsewhere: write a comment link as <TASK-ID>#comment-<public_id> (e.g. IN-42#comment-20261009112345), which renders as a clickable link straight to that comment.",
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID'),
			before: z
				.string()
				.optional()
				.describe('Comment ID — return only comments created before this one'),
			excerpt_chars: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'When set, truncates content.text on text-typed comments to this many characters and adds text_truncated/text_length',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			const conditions = ['ic.task_id = $1'];
			const params: unknown[] = [taskId];
			if (args.before) {
				params.push(args.before);
				conditions.push(
					`(ic.created_at, ic.id) < (SELECT created_at, id FROM task_comments WHERE id = $${params.length})`,
				);
			}
			const r = await db.query<Record<string, unknown>>(
				`SELECT ic.id, ic.public_id, ic.task_id, ic.author_member_id, ic.author_api_key_id,
				        ic.parent_comment_id,
				        ic.content_type, ic.content, ic.chosen_option, ic.created_at,
				        CASE WHEN ic.author_api_key_id IS NOT NULL THEN 'api_key' ELSE m.member_type::text END AS author_type,
				        COALESCE(ca.name, ma.title, m.display_name, 'Admin') AS author_name
				 FROM task_comments ic
				 LEFT JOIN members m ON m.id = ic.author_member_id
				 LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
				 LEFT JOIN api_keys ca ON ca.id = ic.author_api_key_id
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY ic.created_at DESC, ic.id DESC LIMIT 50`,
				params,
			);
			const viewerMemberId = await resolveActorMemberId(db, auth, teamId);
			const reactionsByComment = await loadReactionsForTask(db, taskId, viewerMemberId);
			const commentIds = r.rows.map((row) => row.id as string);
			const attachmentsByComment = await loadAgentAttachmentsForComments(db, commentIds);
			const enriched: Record<string, unknown>[] = r.rows.map((row) => ({
				...row,
				reactions: reactionsByComment.get(row.id as string) ?? [],
				attachments: attachmentsByComment.get(row.id as string) ?? [],
			}));
			const max = args.excerpt_chars as number | undefined;
			if (max == null) return enriched;
			return enriched.map((row) => {
				if (row.content_type !== CommentContentType.Text) return row;
				const content = row.content as { text?: string } | null;
				const text = content?.text;
				if (typeof text !== 'string' || text.length <= max) return row;
				const ex = excerpt(text, max);
				return {
					...row,
					content: { ...content, text: ex.excerpt },
					text_truncated: ex.truncated,
					text_length: ex.length,
				};
			});
		},
		db,
	);

	const reactionKindSchema = z.enum(Object.values(ReactionKind) as [string, ...string[]]);

	tool(
		server,
		'add_reaction',
		'React to a comment without waking its author. Use this to acknowledge mentions or signal "seen / picked up" without forcing the original commenter to run again. Prefer this over a follow-up create_comment when you have nothing substantive to add — comments wake the author, reactions do not. Only react when the situation calls for it: a clean handoff to your own new ticket (✓ on the mention), or a brief acknowledgement that a request landed. If you need the original commenter to read something, post a comment instead.',
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID the comment belongs to'),
			comment_id: z
				.string()
				.uuid()
				.describe(
					'UUID of the comment to react to, as returned by list_comments. Sentinels like "last" / "latest" are not supported — you must pass an explicit UUID.',
				),
			kind: reactionKindSchema.describe(
				`Reaction kind. v1 supports: ${Object.values(ReactionKind).join(', ')}`,
			),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			const memberId = await resolveActorMemberId(db, auth, teamId);
			if (!memberId) return { error: 'No member identity for caller' };
			const result = await addCommentReaction({
				db,
				teamId,
				taskId,
				commentId: args.comment_id as string,
				kind: args.kind as string,
				memberId,
			});
			if (!result.ok) return { error: result.message };
			broadcastCommentFamilyChange(
				wsManager,
				teamId,
				scope.projectId,
				'comment_reactions',
				'INSERT',
				{
					comment_id: args.comment_id,
					task_id: taskId,
					member_id: memberId,
					kind: args.kind,
				},
			);
			return {
				comment_id: args.comment_id,
				kind: args.kind,
				reactions: result.reactions,
			};
		},
		db,
	);

	tool(
		server,
		'remove_reaction',
		'Remove your own reaction from a comment. Removing a reaction does not wake the comment author.',
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID the comment belongs to'),
			comment_id: z
				.string()
				.uuid()
				.describe(
					'UUID of the comment to remove the reaction from, as returned by list_comments. Sentinels like "last" / "latest" are not supported — you must pass an explicit UUID.',
				),
			kind: reactionKindSchema.describe(
				`Reaction kind. v1 supports: ${Object.values(ReactionKind).join(', ')}`,
			),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			const memberId = await resolveActorMemberId(db, auth, teamId);
			if (!memberId) return { error: 'No member identity for caller' };
			const result = await removeCommentReaction({
				db,
				teamId,
				taskId,
				commentId: args.comment_id as string,
				kind: args.kind as string,
				memberId,
			});
			if (!result.ok) return { error: result.message };
			broadcastCommentFamilyChange(
				wsManager,
				teamId,
				scope.projectId,
				'comment_reactions',
				'DELETE',
				{
					comment_id: args.comment_id,
					task_id: taskId,
					member_id: memberId,
					kind: args.kind,
				},
			);
			return {
				comment_id: args.comment_id,
				kind: args.kind,
				reactions: result.reactions,
			};
		},
		db,
	);

	tool(
		server,
		'create_comment',
		'Add a comment to an task. In content, reference teammates with @<agent-slug>. Reference tickets and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug — no @ prefix. Do not wrap any of these in backticks — that makes them inert. To point at a specific earlier comment (in this ticket or another), write a comment link as <TASK-ID>#comment-<public_id> (e.g. IN-42#comment-20261009112345) using a comment public_id from list_comments — do not paraphrase "the comment above". When your comment is a direct response to a specific earlier one (answering a question, confirming/pushing back on a request, providing the follow-up that was asked for) ALWAYS set parent_comment_id to that comment\'s UUID — it wakes the original author with source=reply (so they\'re notified the conversation moved forward) and shows "replying to ..." threading in the UI so other readers can follow the dialogue. Skip parent_comment_id only when the comment is genuinely standalone (a new observation, an unrelated update). If you only need to acknowledge a mention without adding substance, use add_reaction instead.',
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID'),
			content: z.string().describe('Comment text'),
			parent_comment_id: z
				.string()
				.optional()
				.describe(
					'UUID of the comment you are replying to. Setting this wakes that comment\'s author with source=reply and renders this comment as "replying to ..." in the UI.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			let parentCommentId: string | null = null;
			if (args.parent_comment_id) {
				const parentCheck = await db.query(
					'SELECT 1 FROM task_comments WHERE id = $1 AND task_id = $2',
					[args.parent_comment_id, taskId],
				);
				if (parentCheck.rows.length === 0) {
					return { error: 'parent_comment_id does not belong to this task' };
				}
				parentCommentId = args.parent_comment_id as string;
			}
			const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const authorApiKeyId = apiKeyIdFromAuth(auth);
			// Attribute the comment to the run that wrote it (only on the agent-run path) so the
			// goal detail page can show "this progress-update run commented on task X".
			const createdByRunId = auth.type === AuthType.Agent ? (auth.runId ?? null) : null;
			const content = { text: args.content };
			// RETURNING * includes public_id (the timestamp slug for comment links),
			// so the agent gets it back without a follow-up list_comments.
			const r = await db.query<{ id: string; public_id: string }>(
				`INSERT INTO task_comments (task_id, author_member_id, author_api_key_id, parent_comment_id, content_type, content, created_by_run_id) VALUES ($1, $2, $3, $4, $5::comment_content_type, $6::jsonb, $7) RETURNING *`,
				[
					taskId,
					authorMemberId,
					authorApiKeyId,
					parentCommentId,
					CommentContentType.Text,
					JSON.stringify(content),
					createdByRunId,
				],
			);
			// Realtime: notify open task pages. Agent comments come through MCP,
			// which (unlike the REST POST path) never broadcast — so they only
			// appeared on refresh. task_comments has no project_id column, so the
			// helper injects it for the web client's slug resolution.
			broadcastCommentFamilyChange(
				wsManager,
				teamId,
				scope.projectId,
				'task_comments',
				'INSERT',
				r.rows[0],
			);
			await fireCommentWakeups({
				db,
				taskId,
				teamId,
				commentId: r.rows[0].id,
				content,
				contentType: CommentContentType.Text,
				authorMemberId,
				authorUserId: auth.type === AuthType.Admin ? auth.userId : null,
				authorRunId: auth.type === AuthType.Agent ? auth.runId : null,
				parentCommentId,
				wsManager,
			});
			trackBackground(
				recordTaskLinks(
					db,
					teamId,
					taskId,
					args.content as string,
					authorMemberId,
					authorApiKeyId,
					wsManager,
				).catch((e) => log.error('Failed to record task links from comment:', e)),
			);
			// An agent that addresses a teammate by bold/bare name (no @ prefix)
			// notifies no one and the handoff silently stalls. Best-effort warn the
			// author so they can re-post with the proper mention; never block the
			// already-persisted comment on this check.
			if (authorMemberId) {
				const commentText = args.content as string;
				const [teammateWarning, backtickWarning, terminalAskWarning] = await Promise.all([
					buildUnlinkedMentionWarning(db, teamId, authorMemberId, commentText).catch((e) => {
						log.error('Failed to check comment for unlinked teammate references:', e);
						return null;
					}),
					buildBacktickedEntityWarning(db, teamId, scope.projectId, commentText).catch((e) => {
						log.error('Failed to check comment for backticked entity references:', e);
						return null;
					}),
					buildTerminalTaskAskWarning(db, taskId, commentText).catch((e) => {
						log.error('Failed to check comment for asks on a terminal task:', e);
						return null;
					}),
				]);
				const warning = [teammateWarning, backtickWarning, terminalAskWarning]
					.filter((w): w is string => Boolean(w))
					.join(' ');
				if (warning) return { ...r.rows[0], warning };
			}
			return r.rows[0];
		},
		db,
	);

	tool(
		server,
		'update_comment',
		'Edit the text of a comment you posted earlier in THIS run — use it to fix a mistake (a typo, a broken reference, wrong markdown) instead of posting a correction as a new comment. You can only edit a text comment authored by your current run; comments from earlier runs, other agents, or humans are not editable. Editing re-runs the same notification side effects create_comment does, but idempotently: a teammate already notified by this comment is not woken again, while a mention you ADD in the edit (e.g. a bare @<agent-slug> that replaces a backticked, inert one) wakes that teammate for the first time — so fixing a missed mention by editing works. Same reference rules as create_comment: reference tickets and project docs by their bare identifier/filename, teammates with @<agent-slug>, skills by their slug, and never wrap any of these in backticks.',
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID the comment belongs to'),
			comment_id: z
				.string()
				.uuid()
				.describe('UUID of the comment to edit, as returned by create_comment or list_comments.'),
			content: z.string().describe('The replacement comment text (overwrites the existing body).'),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			if (auth.type !== AuthType.Agent || !auth.runId) {
				return { error: 'Only an agent run can edit a comment' };
			}
			const existing = await db.query<{
				content_type: string;
				author_member_id: string | null;
				created_by_run_id: string | null;
				parent_comment_id: string | null;
			}>(
				`SELECT content_type, author_member_id, created_by_run_id, parent_comment_id
				 FROM task_comments WHERE id = $1 AND task_id = $2`,
				[args.comment_id, taskId],
			);
			if (existing.rows.length === 0) {
				return { error: 'Comment not found on this task' };
			}
			const row = existing.rows[0];
			// Scoped to the caller's own comments from the current run: an agent can
			// tidy up what it just posted, but never rewrite history it did not author.
			if (row.created_by_run_id !== auth.runId || row.author_member_id !== auth.memberId) {
				return { error: 'You can only edit a comment you posted during this run' };
			}
			if (row.content_type !== CommentContentType.Text) {
				return { error: 'Only text comments can be edited' };
			}
			const content = { text: args.content };
			const r = await db.query<{ id: string; public_id: string }>(
				`UPDATE task_comments SET content = $1::jsonb WHERE id = $2 RETURNING *`,
				[JSON.stringify(content), args.comment_id],
			);
			broadcastCommentFamilyChange(
				wsManager,
				teamId,
				scope.projectId,
				'task_comments',
				'UPDATE',
				r.rows[0],
			);
			// Re-run the create-time side effects against the new text. Every one is
			// keyed to the comment (or the mention/reply pair), so a target already
			// woken by this comment is deduped while a reference the edit *adds* —
			// a mention or a task link that was previously backticked and inert —
			// fires for the first time. That is what makes "fix it by editing"
			// behave the same as posting it correctly the first time.
			await fireCommentWakeups({
				db,
				taskId,
				teamId,
				commentId: args.comment_id as string,
				content,
				contentType: CommentContentType.Text,
				authorMemberId: auth.memberId,
				authorRunId: auth.runId,
				parentCommentId: row.parent_comment_id,
				wsManager,
			}).catch((e) => log.error('Failed to fire wakeups for edited comment:', e));
			trackBackground(
				recordTaskLinks(
					db,
					teamId,
					taskId,
					args.content as string,
					auth.memberId,
					apiKeyIdFromAuth(auth),
					wsManager,
				).catch((e) => log.error('Failed to record task links from edited comment:', e)),
			);
			const [teammateWarning, backtickWarning] = await Promise.all([
				buildUnlinkedMentionWarning(db, teamId, auth.memberId, args.content as string).catch(
					(e) => {
						log.error('Failed to check edited comment for unlinked teammate references:', e);
						return null;
					},
				),
				buildBacktickedEntityWarning(db, teamId, scope.projectId, args.content as string).catch(
					(e) => {
						log.error('Failed to check edited comment for backticked entity references:', e);
						return null;
					},
				),
			]);
			const warning = [teammateWarning, backtickWarning]
				.filter((w): w is string => Boolean(w))
				.join(' ');
			if (warning) return { ...r.rows[0], warning };
			return r.rows[0];
		},
		db,
	);

	const credentialKindSchema = z.enum([
		CredentialKind.ApiKey,
		CredentialKind.SshPrivateKey,
		CredentialKind.GithubPat,
		CredentialKind.OauthToken,
		CredentialKind.WebhookSecret,
		CredentialKind.Other,
	]);
	const credentialInputTypeSchema = z.enum([
		CredentialInputType.Text,
		CredentialInputType.Textarea,
		CredentialInputType.File,
	]);

	tool(
		server,
		'request_credential',
		'Ask the human assignee to provide a secret value (API key, SSH private key, OAuth token, etc.). Posts a structured comment on the task with a paste form. The agent never sees the value; it gets a placeholder string to embed in env vars or HTTP headers, which the egress proxy later substitutes. Returns immediately with the placeholder; the agent should stop work on whatever needed the credential and wait for a credential_provided wakeup. For HTTP-auth kinds (api_key, oauth_token, github_pat) allowed_hosts is REQUIRED — scope it to the provider API host(s) so the secret can only ever reach those hosts. Always ask for the narrowest scope and shortest expiry the provider offers. If a registered connector capability already covers the provider (e.g. a remote MCP server with OAuth), prefer register_connector over a raw paste.',
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID — the request comment is posted here'),
			name: z
				.string()
				.describe(
					'Secret name. Must match [A-Z][A-Z0-9_]{0,63} (e.g. GITHUB_PAT, ANTHROPIC_API_KEY). The placeholder returned will be __HEZO_SECRET_<name>__.',
				),
			kind: credentialKindSchema.describe(
				'Type of credential — drives validation when the human submits the value',
			),
			instructions: z
				.string()
				.describe(
					'Human-facing prose explaining why you need this credential and how the human can obtain it. Tell the human to set the minimal scope and the shortest expiry the provider supports (e.g. "I need a GitHub PAT with only `repo` scope to push branches, ideally expiring in 7 days. Create one at https://github.com/settings/tokens").',
				),
			input_type: credentialInputTypeSchema
				.optional()
				.describe('Form input type. Defaults: text for short keys, textarea for SSH/multiline.'),
			confirmation_text: z
				.string()
				.optional()
				.describe(
					'Optional yes/no confirmation prompt instead of a paste form (e.g. "Have you added the public key to github.com/owner/repo/settings/keys?"). When set, input_type is ignored.',
				),
			allowed_hosts: z
				.array(z.string())
				.optional()
				.describe(
					'Hostname allowlist for the egress proxy. The credential is only substituted into outbound requests to these hosts. REQUIRED for HTTP-auth kinds (api_key, oauth_token, github_pat) — e.g. ["api.netlify.com"]. Wildcards: *.github.com matches one label segment.',
				),
			allow_body_substitution: z
				.boolean()
				.optional()
				.describe(
					'Request that this credential may be substituted into a small JSON request body, not just headers/URL — for APIs that take the secret in the body, e.g. a login POST that returns a token. The human sees this as a pre-checked box on the paste form and can decline it. Body substitution is gated to a single application/json request under 8KB with a fixed Content-Length; after a login, read the returned token and use it via the Authorization header on later calls.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;

			const name = args.name as string;
			const validation = validateSecretName(name);
			if (!validation.valid) return { error: validation.error };

			// HTTP-auth credentials must be host-scoped: an unscoped api_key/oauth_token/
			// github_pat can never be substituted (egress blocks host-unscoped secrets) or,
			// if later flipped to allow-all, leaks into every host the agent calls. Reject
			// early so the agent re-requests with allowed_hosts. Confirmation-style requests
			// store no value, so hosts don't apply.
			const isConfirmation = !!args.confirmation_text;
			const requestedHosts = (args.allowed_hosts as string[] | undefined) ?? [];
			if (
				!isConfirmation &&
				credentialKindRequiresAllowedHosts(args.kind as string) &&
				requestedHosts.length === 0
			) {
				return {
					error:
						`${args.kind} credentials must declare allowed_hosts — the API host(s) ` +
						`this secret is sent to (e.g. ["api.netlify.com"]). This scopes the egress ` +
						`proxy so the value is only injected into those hosts and never leaks ` +
						`elsewhere. Re-call request_credential with allowed_hosts set.`,
				};
			}

			const placeholder = credentialPlaceholder(name);

			const existing = await db.query<{ id: string; content: Record<string, unknown> }>(
				`SELECT id, content FROM task_comments
				 WHERE task_id = $1
				   AND content_type = 'credential_request'::comment_content_type
				   AND chosen_option IS NULL
				   AND content->>'name' = $2
				 ORDER BY created_at ASC LIMIT 1`,
				[taskId, name],
			);
			if (existing.rows.length > 0) {
				return {
					placeholder,
					comment_id: existing.rows[0].id,
					status: 'pending',
					reused: true,
				};
			}

			const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const content = {
				name,
				kind: args.kind,
				instructions: args.instructions,
				input_type: args.confirmation_text
					? null
					: ((args.input_type as string | undefined) ?? CredentialInputType.Text),
				confirmation_text: args.confirmation_text ?? null,
				allowed_hosts: requestedHosts,
				allow_body_substitution: !!args.allow_body_substitution,
				placeholder,
			};

			const inserted = await db.query<{ id: string }>(
				`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
				 VALUES ($1, $2, 'credential_request'::comment_content_type, $3::jsonb)
				 RETURNING *`,
				[taskId, authorMemberId, JSON.stringify(content)],
			);
			broadcastCommentFamilyChange(
				wsManager,
				teamId,
				scope.projectId,
				'task_comments',
				'INSERT',
				inserted.rows[0],
			);

			events?.emit({
				type: 'credential.requested',
				teamId,
				projectId: null,
				actorType: AuditActorType.Agent,
				actorMemberId: authorMemberId,
				taskId,
				name,
			});

			return {
				placeholder,
				comment_id: inserted.rows[0].id,
				status: 'pending',
				reused: false,
			};
		},
		db,
	);

	tool(
		server,
		'register_connector',
		'Register a third-party MCP server connector for the team and ask the human to authenticate. Posts a connect_required comment on the task with a Connect button; the human clicks it to run OAuth in their own browser. The agent never sees the token; subsequent runs receive the MCP via the egress proxy + placeholder substitution. Idempotent: re-registering an already-active connector returns its current state and fires the wakeup immediately. Auth mechanism is chosen automatically by what the provider supports: servers that advertise OAuth Dynamic Client Registration (most MCP servers) need only mcp_url and authorize with zero config. Providers whose Authorization Server cannot do DCR (e.g. GitHub) require a pre-registered client_id and use the device flow instead — these MUST be registered with provider_id set to a known registry key (e.g. "github"); passing only a raw mcp_url for such a provider will fail to authorize.',
		{
			project: projectArg(),
			task_id: z
				.string()
				.describe('Task identifier or UUID where the connect_required comment is posted'),
			display_name: z
				.string()
				.describe(
					'Human-readable connector name shown in the task chat and on the Connectors page (e.g. "DatoCMS", "Linear").',
				),
			mcp_url: z
				.string()
				.describe(
					'URL of the MCP server (HTTP / SSE). The OAuth dance is discovered by probing this URL for a 401 + WWW-Authenticate header.',
				),
			mcp_transport: z
				.enum(['http', 'sse'])
				.optional()
				.describe('Transport for the MCP server. Defaults to http.'),
			provider_id: z
				.string()
				.optional()
				.describe(
					'Optional registry key (e.g. "datocms"). When set, capability defaults from the shared registry pre-fill display name and allowed hosts.',
				),
			skill_id: z
				.string()
				.optional()
				.describe(
					'Optional ID of a previously-fetched skill document (see fetch_skill_file). When set, the skill file is exposed to every team agent run via the per-adapter skill path.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;

			const displayName = (args.display_name as string).trim();
			const providerId = (args.provider_id as string | undefined)?.trim() || null;
			const mcpUrl = (args.mcp_url as string).trim();
			const mcpTransport = (args.mcp_transport as 'http' | 'sse' | undefined) ?? 'http';
			const skillId = (args.skill_id as string | undefined) ?? null;

			// Slug from providerId if available, else from display_name. Connectors
			// are global, so `name` (UNIQUE) is the idempotency key.
			const slugSource = providerId ?? displayName;
			const name = slugSource
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '')
				.slice(0, 64);
			if (!name) return { error: 'display_name produced an empty slug' };

			const { createOrFetchConnector, statusOf } = await import('../services/connectors/lifecycle');
			const { row, alreadyExisted } = await createOrFetchConnector(db, {
				name,
				displayName,
				mcpUrl,
				mcpTransport,
				// A known provider (e.g. github) carries static headers like
				// X-MCP-Toolsets in its capability — apply them so an agent-registered
				// connector matches the UI "Connect" path.
				mcpHeaders: providerId ? getConnectorCapability(providerId)?.mcpServer.headers : undefined,
				skillId,
				createdByTaskId: taskId,
				providerId,
			});

			if (!alreadyExisted) {
				events?.emit({
					type: 'mcp_connection.created',
					teamId,
					actorType: auth.type === AuthType.Agent ? AuditActorType.Agent : AuditActorType.Admin,
					actorMemberId: auth.type === AuthType.Agent ? auth.memberId : null,
					connectionId: row.id as string,
					name: name as string,
				});
			}

			const status = statusOf(row);

			// If already active, no need for a Connect comment — just signal the
			// caller; they should retry whatever needed the connector.
			if (status === 'active') {
				return {
					connector_id: row.id,
					status,
					name: row.name,
					display_name: row.display_name,
					reused: true,
				};
			}

			// Idempotent comment: don't post a second connect_required for the same
			// connector_id on the same task.
			const existingComment = await db.query<{ id: string }>(
				`SELECT id FROM task_comments
				 WHERE task_id = $1
				   AND content_type = 'connect_required'::comment_content_type
				   AND content->>'connector_id' = $2
				 ORDER BY created_at ASC LIMIT 1`,
				[taskId, row.id],
			);

			let commentId: string;
			if (existingComment.rows.length > 0) {
				commentId = existingComment.rows[0].id;
			} else {
				const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
				const content = {
					connector_id: row.id,
					display_name: displayName,
					provider_id: providerId,
				};
				const inserted = await db.query<{ id: string }>(
					`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
					 VALUES ($1, $2, 'connect_required'::comment_content_type, $3::jsonb)
					 RETURNING *`,
					[taskId, authorMemberId, JSON.stringify(content)],
				);
				commentId = inserted.rows[0].id;
				broadcastCommentFamilyChange(
					wsManager,
					teamId,
					scope.projectId,
					'task_comments',
					'INSERT',
					inserted.rows[0],
				);
			}

			return {
				connector_id: row.id,
				status,
				name: row.name,
				display_name: row.display_name,
				comment_id: commentId,
				reused: alreadyExisted,
			};
		},
		db,
	);

	tool(
		server,
		'fetch_skill_file',
		"Fetch a remote agent skill file (Markdown describing how to use a third-party MCP server) and store it as a global skill (auto_load). Returns the skill_id and slug. Subsequent agent runs across every team get this skill file injected into their adapter's skills directory. Idempotent on the derived slug — re-fetching the same URL updates the existing skill.",
		{
			project: projectArg(),
			url: z
				.string()
				.describe(
					'HTTPS URL of the skill file. Only http/https schemes are allowed; response must be < 256KB; 10s timeout.',
				),
			title: z
				.string()
				.optional()
				.describe('Human-readable title shown in the team KB. Defaults to the URL pathname.'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const url = (args.url as string).trim();
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				return { error: 'Invalid URL' };
			}
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				return { error: 'Only http/https URLs are allowed' };
			}

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 10_000);
			let res: Response;
			try {
				res = await fetch(url, { signal: controller.signal });
			} catch (e) {
				clearTimeout(timeout);
				return { error: `Fetch failed: ${(e as Error).message}` };
			}
			clearTimeout(timeout);
			if (!res.ok) {
				return { error: `Fetch failed: HTTP ${res.status}` };
			}
			const contentLength = res.headers.get('content-length');
			if (contentLength && Number(contentLength) > 256 * 1024) {
				return { error: 'Response too large (>256KB)' };
			}
			const body = await res.text();
			if (body.length > 256 * 1024) {
				return { error: 'Response too large (>256KB)' };
			}

			// Slug from URL pathname (e.g. /docs/mcp-server/agent-skill.md → agent-skill).
			const pathSlug = parsed.pathname
				.split('/')
				.filter(Boolean)
				.pop()
				?.replace(/\.[a-z0-9]+$/i, '')
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
			const hostSlug = parsed.host.toLowerCase().replace(/[^a-z0-9]+/g, '-');
			const slug = `${hostSlug}--${pathSlug || 'skill'}`.slice(0, 64);
			const title = (args.title as string | undefined) ?? parsed.pathname;

			const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const { createHash } = await import('node:crypto');
			const contentHash = createHash('sha256').update(body).digest('hex');
			const description = deriveSkillSummary(body);

			const existing = await db.query<{ id: string }>('SELECT id FROM skills WHERE slug = $1', [
				slug,
			]);
			// Global skill, flagged auto_load so the runner writes it to
			// ~/.claude/skills for every run. Idempotent on slug.
			const upserted = await db.query<{ id: string; slug: string }>(
				`INSERT INTO skills (name, slug, description, content, source_url, content_hash, created_by_member_id, tags, auto_load)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, true)
				 ON CONFLICT (slug) DO UPDATE SET
				   name = EXCLUDED.name,
				   description = EXCLUDED.description,
				   content = EXCLUDED.content,
				   source_url = EXCLUDED.source_url,
				   content_hash = EXCLUDED.content_hash,
				   auto_load = true,
				   updated_at = now()
				 RETURNING id, slug`,
				[title, slug, description, body, url, contentHash, authorMemberId],
			);

			return {
				skill_id: upserted.rows[0].id,
				slug: upserted.rows[0].slug,
				source_url: url,
				size_bytes: body.length,
				reused: existing.rows.length > 0,
			};
		},
		db,
	);

	// Approvals
	tool(
		server,
		'list_approvals',
		'List pending approvals. Pass excerpt_chars (e.g. 500) to truncate long fields inside payload (e.g. skill-proposal content); omit for full payload.',
		{
			project: projectArg(),
			excerpt_chars: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'When set, truncates long string fields inside payload (e.g. skill-proposal content) and adds *_truncated/_length companions',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const r = await db.query<Record<string, unknown>>(
				`SELECT ${APPROVAL_COLUMNS} FROM approvals
				 WHERE team_id = $1 AND status = $2::approval_status
				 ORDER BY created_at DESC`,
				[scope.teamId, ApprovalStatus.Pending],
			);
			const max = args.excerpt_chars as number | undefined;
			if (max == null) return r.rows;
			return r.rows.map((row) => excerptApprovalPayload(row, max));
		},
		db,
	);

	tool(
		server,
		'resolve_approval',
		'Approve or deny an approval',
		{
			approval_id: z.string().describe('Approval ID'),
			status: z
				.enum([ApprovalStatus.Approved, ApprovalStatus.Denied])
				.describe('Resolution status'),
			resolution_note: z.string().optional().describe('Note'),
		},
		async (args, db, auth) => {
			const existing = await db.query<{ team_id: string; payload: Record<string, unknown> }>(
				'SELECT team_id, payload FROM approvals WHERE id = $1',
				[args.approval_id],
			);
			if (existing.rows.length === 0) return { error: 'Approval not found' };
			const approvalTeamId = existing.rows[0].team_id;
			const approvalProjectId = existing.rows[0].payload?.project_id;
			if (typeof approvalProjectId === 'string') {
				const denied = await authorizeScope(db, auth, {
					teamId: approvalTeamId,
					projectId: approvalProjectId,
				});
				if (denied) return { error: denied };
			} else {
				const denied = await authorizeTeam(db, auth, approvalTeamId);
				if (denied) return { error: denied };
				if (auth.type === AuthType.Agent && !auth.crossProject) {
					return { error: 'Access denied: run is not scoped to resolve this approval' };
				}
			}

			const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const resolved = await resolveApproval(db, args.approval_id as string, {
				status: args.status as typeof ApprovalStatus.Approved | typeof ApprovalStatus.Denied,
				resolutionNote: typeof args.resolution_note === 'string' ? args.resolution_note : null,
				dataDir,
				actorMemberId,
				wsManager,
				events,
			});
			if (!resolved.ok) {
				return { error: resolved.message };
			}

			const { row, sideEffects } = resolved;
			const teamId = existing.rows[0].team_id;
			broadcastApprovalChange(wsManager, teamId, 'UPDATE', row);
			if (wsManager) {
				const room = wsRoom.team(teamId);
				for (const effect of sideEffects) {
					broadcastRowChange(wsManager, room, effect.table, effect.op, effect.row);
				}
			}
			return row;
		},
		db,
	);

	// Costs
	tool(
		server,
		'get_costs',
		'Get the cost summary for a project',
		{
			project: projectArg(),
			group_by: z.enum(['agent', 'day']).optional().describe('Group costs by'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			if (args.group_by === 'agent') {
				const r = await db.query(
					`SELECT ce.member_id, COALESCE(ma.title, m.display_name) AS agent_title, sum(ce.amount_cents)::int AS total_cents
				 FROM cost_entries ce LEFT JOIN members m ON m.id = ce.member_id LEFT JOIN member_agents ma ON ma.id = ce.member_id
				 WHERE ce.project_id = $1 GROUP BY ce.member_id, ma.title, m.display_name`,
					[scope.projectId],
				);
				return r.rows;
			}
			if (args.group_by === 'day') {
				const r = await db.query(
					`SELECT date_trunc('day', ce.created_at)::date AS day, sum(ce.amount_cents)::int AS total_cents
				 FROM cost_entries ce WHERE ce.project_id = $1 GROUP BY day ORDER BY day`,
					[scope.projectId],
				);
				return r.rows;
			}
			const r = await db.query(
				`SELECT sum(amount_cents)::int AS total_cents, count(*)::int AS entry_count FROM cost_entries WHERE project_id = $1`,
				[scope.projectId],
			);
			return r.rows[0];
		},
		db,
	);

	// System Prompt Management — read: any agent/admin in same team; write: coach only
	tool(
		server,
		'get_agent_system_prompt',
		"Read an agent's system prompt. Accessible by any agent or the admin in the same team. Returns the resolved role doc by default — `{{…}}` placeholders substituted with the real team name, manager, skills, project docs, and team context — so you can see what the agent actually says about itself with real values. Pass placeholders=false to get the raw stored template with `{{…}}` placeholders intact; only do this when you intend to edit the prompt and need a safe round-trip back through update_agent_system_prompt.",
		{
			project: projectArg(),
			agent_id: z.string().describe('Target agent — its slug (e.g. "engineer") or member ID'),
			placeholders: z
				.boolean()
				.optional()
				.default(true)
				.describe(
					'When true (default) substitutes `{{…}}` placeholders with real team/team values. When false returns the raw stored template — needed when reading before update_agent_system_prompt so placeholders survive the round-trip.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Admin) {
				return { error: 'Access denied' };
			}

			// Agents reference teammates by slug; accept either form. The team-scoped
			// query below is the authorization check — resolveAgentId can fall back to
			// an HQ agent, which must not be readable through a project team.
			const agentId = await resolveAgentId(db, teamId, args.agent_id as string);
			if (!agentId) return { error: 'Agent not found in this team' };

			const agent = await db.query<{ title: string; slug: string }>(
				`SELECT ma.title, ma.slug
				 FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.team_id = $2`,
				[agentId, teamId],
			);
			if (agent.rows.length === 0) return { error: 'Agent not found in this team' };

			const raw = await getAgentSystemPrompt(db, teamId, agentId);
			const system_prompt = args.placeholders
				? await resolveSystemPrompt(db, raw, {
						teamId,
						agentId,
						mode: 'placeholders',
					})
				: raw;
			return { ...agent.rows[0], system_prompt };
		},
		db,
	);

	tool(
		server,
		'get_agent_system_prompts',
		`Read multiple agent system prompts in one call (max ${MAX_BATCH_AGENT_SYSTEM_PROMPTS}). Per-item \`mode\` chooses the resolution depth: \`placeholders\` (default) substitutes \`{{…}}\` with real values and stops, matching get_agent_system_prompt's default; \`preview\` additionally appends the resolver's runtime blocks (Project State, Team Context, Teammates, Working Guidelines) minus the per-run Run Context, matching the web UI's preview panel; \`raw\` returns the stored template untouched. Use this to compare prompts across the team in one round-trip — e.g. Captain auditing how team_context renders for every agent. SIZE: a single \`preview\` fills most of the 64KB result cap (result_too_large), so batch multiple items only as \`raw\`/\`placeholders\` and fetch previews one at a time. For a single prompt, use get_agent_system_prompt.`,
		{
			project: projectArg(),
			items: z
				.array(
					z.object({
						agent_id: z.string().describe('Target agent member ID or slug'),
						mode: z
							.enum(['raw', 'placeholders', 'preview'])
							.optional()
							.describe(
								'Resolution depth: raw | placeholders (default) | preview. See tool description.',
							),
					}),
				)
				.min(1)
				.max(MAX_BATCH_AGENT_SYSTEM_PROMPTS)
				.describe(`Up to ${MAX_BATCH_AGENT_SYSTEM_PROMPTS} items.`),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Admin) {
				return { error: 'Access denied' };
			}

			const items = args.items as Array<{ agent_id: string; mode?: SystemPromptMode }>;
			const results = await Promise.all(
				items.map(async (item, index) => {
					try {
						const out = await fetchAgentSystemPromptForBatch(
							db,
							teamId,
							item.agent_id,
							item.mode ?? 'placeholders',
						);
						return { index, ok: true as const, ...out };
					} catch (e) {
						if (e instanceof AgentSystemPromptError) {
							return { index, ok: false as const, agent_id: item.agent_id, error: e.message };
						}
						log.error('Unexpected error in get_agent_system_prompts:', e);
						return {
							index,
							ok: false as const,
							agent_id: item.agent_id,
							error: e instanceof Error ? e.message : 'internal_error',
						};
					}
				}),
			);
			return results;
		},
		db,
	);

	tool(
		server,
		'update_agent_system_prompt',
		'Apply a system prompt change for an agent. Callable by the Coach agent (for after-task learned-rules updates) or by the Captain of the same team (during team-coherence reviews). The change is applied immediately and a revision snapshot is stored so the admin can restore previous versions.',
		{
			project: projectArg(),
			agent_id: z.string().describe('Target agent — its slug (e.g. "engineer") or member ID'),
			new_system_prompt: z
				.string()
				.describe(
					`The full updated system prompt. It MUST keep every required substitution variable (${REQUIRED_SYSTEM_PROMPT_VARS.join(', ')}) — read the current prompt with get_agent_system_prompt(placeholders=false) first and preserve them, or the update is rejected. (The CEO and Coach are exempt.)`,
				),
			change_summary: z.string().describe('Summary of what changed and why'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			const allowed = (await isCoach(db, auth)) || (await canCoordinateTeam(db, auth, teamId));
			if (!allowed) {
				return {
					error: 'Access denied: only the Coach or the Captain can update system prompts',
				};
			}

			// Accept a slug or member ID; the team-scoped check keeps an HQ agent
			// (resolveAgentId's fallback) from being editable through a project team.
			const agentId = await resolveAgentId(db, teamId, args.agent_id as string);
			if (!agentId) return { error: 'Agent not found in this team' };
			const agentCheck = await db.query<{ id: string; slug: string }>(
				`SELECT ma.id, ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.team_id = $2`,
				[agentId, teamId],
			);
			if (agentCheck.rows.length === 0) return { error: 'Agent not found in this team' };

			// A revised prompt must keep the required substitution variables.
			// Instance singletons (CEO/Coach) are exempt — they have no in-team
			// manager, so the {{reports_to}} requirement does not apply.
			const targetSlug = agentCheck.rows[0].slug;
			const isInstanceSingleton = (INSTANCE_AGENT_SLUGS as readonly string[]).includes(targetSlug);
			if (!isInstanceSingleton) {
				const promptError = requiredSystemPromptVarsError(args.new_system_prompt as string);
				if (promptError) return { error: promptError };
			}

			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;

			const doc = await upsertDocument(db, undefined, {
				scope: {
					type: DocumentType.AgentSystemPrompt,
					teamId,
					memberAgentId: agentId,
				},
				content: args.new_system_prompt as string,
				changeSummary: args.change_summary as string,
				authorMemberId: callerMemberId,
			});

			trackBackground(
				enqueueTeamCoherenceReviewTask(db, teamId, 'prompt_updated').catch((e) =>
					log.error('Failed to enqueue team coherence review after prompt update:', e),
				),
			);

			return { applied: true, document_id: doc.id };
		},
		db,
	);

	// Description maintenance — used by the Captain (and self) to write back
	// auto-generated agent and team summaries.
	tool(
		server,
		'set_agent_summary',
		'Save a short human-readable summary for an agent (≤1000 chars, single paragraph, plain prose). Callable by any agent in the same team or any the admin; the Captain is the expected caller, but agents may also self-summarise.',
		{
			project: projectArg(),
			agent_id: z.string().describe('Target agent — its slug (e.g. "engineer") or member ID'),
			summary: z
				.string()
				.trim()
				.min(1, 'summary must be non-empty')
				.max(1000, 'summary too long (max 1000)')
				.describe('The new summary, ≤1000 chars'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Admin) {
				return { error: 'Access denied' };
			}

			// Length/non-empty enforced by the schema; the SDK rejects violations
			// before the handler. `.trim()` in the schema means the stored value is
			// already trimmed.
			const summary = (args.summary as string).trim();

			// Accept a slug or member ID; the team_id filter scopes the write so an HQ
			// agent (resolveAgentId's fallback) can't be summarised through this team.
			const agentId = await resolveAgentId(db, teamId, args.agent_id as string);
			if (!agentId) return { error: 'Agent not found in this team' };
			const r = await db.query<{ id: string }>(
				`UPDATE member_agents SET summary = $1, updated_at = now()
				 WHERE id = $2 AND id IN (
				   SELECT m.id FROM members m WHERE m.id = $2 AND m.team_id = $3
				 )
				 RETURNING id`,
				[summary, agentId, teamId],
			);
			if (r.rows.length === 0) return { error: 'Agent not found in this team' };

			trackBackground(
				enqueueTeamCoherenceReviewTask(db, teamId, 'summary_updated').catch((e) =>
					log.error('Failed to enqueue team coherence review after summary update:', e),
				),
			);

			return { updated: true };
		},
		db,
	);

	tool(
		server,
		'set_team_summary',
		'Save the team-level collaboration summary for a team (≤4000 chars, plain prose, may span paragraphs). Only callable by the Captain of that team.',
		{
			project: projectArg(),
			summary: z
				.string()
				.trim()
				.min(1, 'summary must be non-empty')
				.max(4000, 'summary too long (max 4000)')
				.describe('The new team summary, ≤4000 chars'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (!(await canCoordinateTeam(db, auth, teamId))) {
				return { error: 'Access denied: only the Captain can update the team summary' };
			}

			// Length/non-empty enforced by the schema; `.trim()` already trimmed it.
			const summary = (args.summary as string).trim();

			await db.query('UPDATE teams SET summary = $1, updated_at = now() WHERE id = $2', [
				summary,
				teamId,
			]);

			return { updated: true };
		},
		db,
	);

	tool(
		server,
		'report_no_work',
		'Declare that, after evaluating the current task this run, there is genuinely nothing to do — no comment, sub-task, status change, code change, or other action is warranted. Records the run as an intentional no-op so it is NOT flagged as a failed empty run, and is the correct, auditable way to end such a turn (preferred over posting a redundant "nothing to do" comment). Use ONLY when you have truly concluded no action is needed this turn — never to skip, defer, or avoid real work.',
		{
			reason: z
				.string()
				.trim()
				.min(1, 'reason must be non-empty')
				.describe('One-line explanation of why there is nothing to do this run.'),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent || !auth.runId) {
				return { error: 'report_no_work is only available within an agent run' };
			}
			// Non-empty (after trim) enforced by the schema.
			const reason = (args.reason as string).trim();
			await markRunReportedNoWork(db, auth.runId, reason);
			return { ok: true };
		},
		db,
	);

	tool(
		server,
		'set_agent_team_context',
		"Save the team-relationships context for an agent (≤6000 chars, plain prose, second-person 'you', describes how this agent relates to its manager, direct reports, peers, indirect reports, and humans). This blob is injected into the agent's system prompt at the start of every run. Only callable by the Captain of the same team.",
		{
			project: projectArg(),
			agent_id: z.string().describe('Target agent — its slug (e.g. "engineer") or member ID'),
			content: z
				.string()
				.trim()
				.min(1, 'content must be non-empty')
				.max(6000, 'content too long (max 6000)')
				.describe('The new team_context, ≤6000 chars'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (!(await canCoordinateTeam(db, auth, teamId))) {
				return { error: 'Access denied: only the Captain can update agent team contexts' };
			}

			// Length/non-empty enforced by the schema; `.trim()` already trimmed it.
			const content = (args.content as string).trim();

			// Accept a slug or member ID; the team_id filter scopes the write so an HQ
			// agent (resolveAgentId's fallback) can't be written through this team.
			const agentId = await resolveAgentId(db, teamId, args.agent_id as string);
			if (!agentId) return { error: 'Agent not found in this team' };
			const r = await db.query<{ id: string }>(
				`UPDATE member_agents SET team_context = $1, updated_at = now()
				 WHERE id = $2 AND id IN (
				   SELECT m.id FROM members m WHERE m.id = $2 AND m.team_id = $3
				 )
				 RETURNING id`,
				[content, agentId, teamId],
			);
			if (r.rows.length === 0) return { error: 'Agent not found in this team' };

			return { updated: true };
		},
		db,
	);

	tool(
		server,
		'set_agent_reports_to',
		"Set or change the manager an agent reports to — the structural reporting line in the org chart that gates delegation. Work can only be assigned to/from an agent along this line, so an agent whose manager is unset can't be delegated to or hand work down. Use this to wire up reporting structure (e.g. after hiring specialists, point them at their lead) or fix it during a coherence review. Pass the target agent and its new manager (both by slug or member ID); pass an empty reports_to to clear the line. Callable by the team's Captain or an HQ instance agent (CEO/Coach) acting in the team. The Captain, CEO, and Coach have fixed reporting lines (Captain → CEO; CEO/Coach → admin) that cannot be changed.",
		{
			project: projectArg(),
			agent_id: z.string().describe('Target agent — its slug (e.g. "engineer") or member ID'),
			reports_to: z
				.string()
				.describe(
					"The new manager — an existing agent's slug (or member ID) on this team. Pass an empty string to clear the reporting line.",
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (!(await canCoordinateTeam(db, auth, teamId))) {
				return { error: 'Access denied: only the Captain or CEO can set reporting lines' };
			}

			// Resolve the target and confirm it belongs to this team (not an HQ fallback).
			const agentId = await resolveAgentId(db, teamId, args.agent_id as string);
			if (!agentId) return { error: 'Agent not found in this team' };
			const target = await db.query<{ slug: string }>(
				`SELECT ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.team_id = $2`,
				[agentId, teamId],
			);
			if (target.rows.length === 0) return { error: 'Agent not found in this team' };

			// Structurally-fixed lines are immutable: the Captain always reports to the
			// CEO; the CEO and Coach report to the admin. These cannot be re-pointed.
			if (hasFixedReportsTo(target.rows[0].slug)) {
				return {
					error: `The ${target.rows[0].slug} reporting line is fixed and cannot be changed`,
				};
			}

			const raw = String(args.reports_to ?? '').trim();
			let managerId: string | null = null;
			if (raw) {
				managerId = await resolveAgentId(db, teamId, raw);
				if (!managerId) return { error: `reports_to: no agent '${raw}' in this team` };
				if (managerId === agentId) return { error: 'An agent cannot report to itself' };
				// Reject a cycle: walk up the proposed manager's chain — if it reaches
				// the target, the new link would close a loop.
				const seen = new Set<string>();
				let cursor: string | null = managerId;
				while (cursor !== null) {
					if (cursor === agentId) {
						return { error: 'reports_to would create a reporting cycle' };
					}
					if (seen.has(cursor)) break;
					seen.add(cursor);
					const parent: { rows: Array<{ reports_to: string | null }> } = await db.query<{
						reports_to: string | null;
					}>(`SELECT reports_to FROM member_agents WHERE id = $1`, [cursor]);
					cursor = parent.rows[0]?.reports_to ?? null;
				}
			}

			await db.query(`UPDATE member_agents SET reports_to = $1, updated_at = now() WHERE id = $2`, [
				managerId,
				agentId,
			]);

			const updated = await db.query<Record<string, unknown>>(
				`SELECT m.id, m.team_id, ma.slug, ma.title, ma.reports_to,
				        (SELECT ma2.title FROM member_agents ma2 WHERE ma2.id = ma.reports_to)
				          AS reports_to_title
				 FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1`,
				[agentId],
			);
			if (updated.rows[0]) {
				broadcastRowChange(
					wsManager,
					wsRoom.team(teamId),
					'member_agents',
					'UPDATE',
					updated.rows[0],
				);
			}

			return {
				applied: true,
				agent: target.rows[0].slug,
				reports_to: managerId ? raw : null,
			};
		},
		db,
	);

	tool(
		server,
		'get_agent_team_context',
		"Read an agent's stored team-relationships context. Useful for the Captain when regenerating siblings' contexts. Accessible by any agent or the admin in the same team.",
		{
			project: projectArg(),
			agent_id: z.string().describe('Target agent — its slug (e.g. "engineer") or member ID'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Admin) {
				return { error: 'Access denied' };
			}

			// Accept a slug or member ID; the team-scoped query is the authorization
			// check, keeping an HQ agent (resolveAgentId's fallback) out of this team.
			const agentId = await resolveAgentId(db, teamId, args.agent_id as string);
			if (!agentId) return { error: 'Agent not found in this team' };
			const r = await db.query<{ title: string; slug: string; team_context: string }>(
				`SELECT ma.title, ma.slug, ma.team_context
				 FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.team_id = $2`,
				[agentId, teamId],
			);
			if (r.rows.length === 0) return { error: 'Agent not found in this team' };

			return r.rows[0];
		},
		db,
	);

	tool(
		server,
		'set_agent_status',
		"Retire (disable) or reinstate (enable) an agent on a project's team. Callable by the team's Captain or by the CEO running in the team. Disabling stops the agent from being scheduled and unassigns it from every open task; enabling resumes scheduling. The change is fully reversible and preserves all of the agent's history, so this is the right way to remove a role the team no longer needs (e.g. after a coherence review). The Captain and the instance agents (CEO/Coach) cannot be disabled this way. Confirm with the admin before retiring an agent.",
		{
			project: projectArg(),
			agent: z
				.string()
				.trim()
				.min(1, 'agent is required')
				.describe(
					'Target agent — its slug (e.g. "engineer") or member ID. Must be a member of this project\'s team.',
				),
			status: z
				.enum([AgentAdminStatus.Enabled, AgentAdminStatus.Disabled])
				.describe('"disabled" retires the agent; "enabled" reinstates it.'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (auth.type !== AuthType.Agent) {
				return { error: 'set_agent_status is only callable by agents' };
			}
			// The team's own Captain (running in-team) or an HQ instance agent — the
			// CEO, whether acting from the cross-team chat session or a task run scoped
			// into this team. canCoordinateTeam covers the Captain and the in-team HQ
			// case; isHqInstanceAgent additionally covers the cross-team CEO session,
			// whose run is scoped to HQ rather than this team.
			const allowed =
				(await canCoordinateTeam(db, auth, teamId)) || (await isHqInstanceAgent(db, auth));
			if (!allowed) {
				return {
					error: "Access denied: only the Captain or the CEO can change an agent's status",
				};
			}

			// agent non-empty enforced by the schema.
			const ref = (args.agent as string).trim();
			const target = await db.query<{ id: string; slug: string }>(
				`SELECT ma.id, ma.slug FROM member_agents ma
				 JOIN members m ON m.id = ma.id
				 WHERE m.team_id = $1 AND (ma.id::text = $2 OR ma.slug = $2)
				 LIMIT 1`,
				[teamId, ref],
			);
			if (target.rows.length === 0) return { error: `Agent not found in this team: ${ref}` };
			const { id: agentId, slug } = target.rows[0];

			const status = args.status as AgentAdminStatus;
			const protectedSlugs: readonly string[] = [
				CAPTAIN_AGENT_SLUG,
				CEO_AGENT_SLUG,
				COACH_AGENT_SLUG,
			];
			if (status === AgentAdminStatus.Disabled && protectedSlugs.includes(slug)) {
				// The HQ instance singletons (CEO/Coach) are essential to the whole
				// instance and cannot be disabled through any path — not even the admin
				// web UI. The Captain is protected from agent-initiated disabling here,
				// but the admin may still retire one from the web UI if truly needed.
				const isInstance = (INSTANCE_AGENT_SLUGS as readonly string[]).includes(slug);
				return {
					error: isInstance
						? `The ${slug} role is essential to the instance and cannot be disabled.`
						: `The ${slug} role is essential and cannot be retired with this tool; the admin can disable it from the web UI if truly needed.`,
				};
			}

			const result = await setAgentAdminStatus(
				{ db, wsManager, events },
				{
					teamId,
					agentId,
					status,
					actorType: AuditActorType.Agent,
					actorMemberId: auth.memberId,
				},
			);
			if (!result.ok && result.reason === 'not_found') {
				return { error: `Agent not found in this team: ${ref}` };
			}
			if (!result.ok && result.reason === 'already_in_state') {
				return { error: `Agent is already ${status}` };
			}
			return { updated: true, agent_id: agentId, slug, admin_status: status };
		},
		db,
	);

	// Project docs
	tool(
		server,
		'list_project_docs',
		'List project documentation files (PRD, spec, implementation plan, etc.)',
		{
			project: projectArg(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const docs = await listDocuments(db, {
				type: DocumentType.ProjectDoc,
				teamId: scope.teamId,
				projectId: scope.projectId,
			});
			return {
				files: docs.map((d) => ({
					id: d.id,
					filename: d.slug,
					title: d.title,
					updated_at: d.updated_at,
				})),
			};
		},
		db,
	);

	// Shared error copy for tools that take an asset path.
	const assetPathError = (raw: string) =>
		`Invalid asset path '${raw}': up to ${ASSET_MAX_FOLDER_DEPTH} folder levels, each segment starting with a letter or digit (e.g. "launch/images/hero.png").`;

	tool(
		server,
		'list_project_assets',
		"List the project's assets — files in the assets library (UI mockups, wireframes, diagrams, PDFs, scripts, and generated markdown such as blog posts or reports). Filenames may carry a folder prefix up to 2 levels deep (e.g. `launch/images/hero.png`); reference one in a comment or doc as `assets/<path>` exactly as returned here (e.g. assets/launch/images/hero.png), no backticks. You can author text-based assets with write_project_asset and reorganize with move_project_asset / copy_project_asset; deletion is admin-gated via request_asset_deletion. Binary assets (images, PDFs, media) are human-uploaded.",
		{
			project: projectArg(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const assets = await db.query<{
				id: string;
				original_filename: string;
				content_type: string;
				created_at: string;
			}>(
				`SELECT id, original_filename, content_type, created_at
				 FROM assets WHERE project_id = $1 ORDER BY created_at DESC`,
				[scope.projectId],
			);
			return {
				files: assets.rows.map((a) => ({
					id: a.id,
					filename: a.original_filename,
					content_type: a.content_type,
					created_at: a.created_at,
				})),
			};
		},
		db,
	);

	tool(
		server,
		'write_project_asset',
		'Save a text-based file to the project assets library so a human can open it (an interactive HTML mockup, an SVG diagram, a plain-text export, a script, or a markdown deliverable such as a blog post or report). Allowed extensions: .html, .svg, .txt, .md, plus script/text formats stored as plain text (.sh, .py, .js, .ts, .json, .csv, .yaml, .yml). The filename may include a folder path up to 2 levels deep (e.g. "scripts/deploy-check.sh" or "launch/images/hero.svg") — folders spring into existence with their first asset. Re-saving the same path overwrites it, so the reference stays stable; overwrite matching is PATH-EXACT ("x.html" and "blog/x.html" are different assets — after a move, write to the new full path or you will fork the file). Returns the reference string to drop into a comment as `assets/<path>` (no backticks). HTML opens interactively in a new tab; markdown renders with a rich preview and a view-source toggle. Use a markdown asset for a standalone deliverable opened from the assets library; use write_project_doc for project context docs (specs, PRDs, research). Mockups and other deliverables belong here, never committed to the source repo.',
		{
			project: projectArg(),
			filename: z
				.string()
				.describe(
					'Path to write, optionally foldered (e.g. "ui-mockups.html", "scripts/check.sh")',
				),
			content: z.string().describe('File content'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const { teamId, projectId } = scope;
			const filename = normalizeAssetPath(args.filename as string);
			if (filename === null) return { error: assetPathError(args.filename as string) };
			const ext = extensionOf(assetBasename(filename));
			const contentType = ext
				? ATTACHMENT_EXTENSIONS[ext as keyof typeof ATTACHMENT_EXTENSIONS]
				: undefined;
			if (!contentType || !isAgentAuthorableAssetMime(contentType)) {
				return {
					error:
						'Asset must be a text-based file: .html, .svg, .txt, .md, or a script/text format (.sh, .py, .js, .ts, .json, .csv, .yaml, .yml). Other types are human-uploaded.',
				};
			}

			const blob = new Blob([args.content as string], { type: contentType });
			if (blob.size > ATTACHMENT_MAX_BYTES) {
				return { error: 'Asset exceeds 10 MB.' };
			}

			const assetId = crypto.randomUUID();
			const { byteSize, sha256 } = await writeAsset(dataDir, teamId, projectId, assetId, blob);
			const uploadedBy = auth.type === AuthType.Agent ? auth.memberId : null;
			let result: Awaited<ReturnType<typeof upsertProjectAsset>>;
			try {
				result = await upsertProjectAsset(db, {
					assetId,
					teamId,
					projectId,
					contentType,
					byteSize,
					sha256,
					desiredName: filename,
					uploadedByMemberId: uploadedBy,
				});
			} catch (e) {
				await deleteAsset(dataDir, teamId, projectId, assetId).catch(() => {});
				throw e;
			}
			if (result.replacedAssetId) {
				await deleteAsset(dataDir, teamId, projectId, result.replacedAssetId).catch(() => {});
			}
			broadcastRowChange(wsManager, wsRoom.team(teamId), 'assets', 'INSERT', {
				id: result.id,
				team_id: teamId,
				project_id: projectId,
				original_filename: result.original_filename,
			});
			return { written: true, id: result.id, reference: `assets/${result.original_filename}` };
		},
		db,
	);

	tool(
		server,
		'read_project_asset',
		'Read a project asset\'s contents by path (e.g. "ui-mockups.html" or "scripts/check.sh") — the files that list_project_assets returns (UI mockups, wireframes, SVG diagrams, text exports, scripts, markdown deliverables). Use the full path exactly as listed, folder prefix included. Text-based assets (HTML, SVG, plain text, markdown) come back inline as `content`. Binary assets (images, PDFs, media) are not inlined; the response gives a read-only container path under /workspace/.hezo/assets/ to open directly. For markdown project docs use read_project_doc instead.',
		{
			project: projectArg(),
			filename: z
				.string()
				.describe('Asset path to read (e.g. "ui-mockups.html", "launch/images/hero.png")'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const { teamId, projectId } = scope;
			const filename = normalizeAssetPath(args.filename as string);
			if (filename === null) return { error: assetPathError(args.filename as string) };

			const found = await db.query<{
				id: string;
				original_filename: string;
				content_type: string;
				byte_size: string;
			}>(
				`SELECT id, original_filename, content_type, byte_size
				 FROM assets WHERE project_id = $1 AND original_filename = $2`,
				[projectId, filename],
			);
			if (found.rows.length === 0) return { error: `Asset '${filename}' not found` };
			const asset = found.rows[0];

			// Text-based assets are returned inline; binary assets are left on the
			// read-only bind mount for the agent to open directly.
			const isText =
				asset.content_type.startsWith('text/') || asset.content_type === 'image/svg+xml';
			if (!isText) {
				return {
					filename: asset.original_filename,
					content_type: asset.content_type,
					byte_size: Number(asset.byte_size),
					binary: true,
					path: `${AGENT_ATTACHMENT_DIR}/${asset.id}`,
				};
			}

			const buf = await readAsset(dataDir, teamId, projectId, asset.id);
			return {
				filename: asset.original_filename,
				content_type: asset.content_type,
				content: buf.toString('utf-8'),
			};
		},
		db,
	);

	tool(
		server,
		'move_project_asset',
		'Move or rename a project asset within the assets library: change its folder (up to 2 levels deep), its filename, or both — folders spring into existence when the first asset lands in them and vanish with their last one. The stored file does not change, so the destination must keep the same extension. Moves never overwrite: if the destination path is taken the call fails. IMPORTANT: existing text references to the old `assets/<path>` in comments and docs are NOT rewritten — they degrade to plain text — so update the places that cite the old path, and prefer organizing assets early over moving them later. Agents cannot delete assets (deletion is admin-gated via request_asset_deletion); moving something obsolete into an archive folder is the self-serve alternative.',
		{
			project: projectArg(),
			from: z.string().describe('Current asset path (e.g. "hero.png" or "launch/hero.png")'),
			to: z.string().describe('Destination path (e.g. "launch/images/hero.png")'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const from = normalizeAssetPath(args.from as string);
			if (from === null) return { error: assetPathError(args.from as string) };
			const to = normalizeAssetPath(args.to as string);
			if (to === null) return { error: assetPathError(args.to as string) };
			if (from === to) return { error: 'Source and destination are the same path.' };
			const fromExt = extensionOf(assetBasename(from));
			if (extensionOf(assetBasename(to)) !== fromExt) {
				return {
					error: `Destination must keep the '.${fromExt ?? ''}' extension — the stored file type does not change on a move. Use copy_project_asset or a fresh write_project_asset for format changes.`,
				};
			}
			const found = await db.query<{ id: string }>(
				'SELECT id FROM assets WHERE project_id = $1 AND original_filename = $2',
				[scope.projectId, from],
			);
			if (found.rows.length === 0) return { error: `Asset 'assets/${from}' not found` };
			const assetId = found.rows[0].id;
			try {
				await db.query('UPDATE assets SET original_filename = $1 WHERE id = $2', [to, assetId]);
			} catch (e) {
				if (isUniqueViolation(e)) {
					return {
						error: `Destination 'assets/${to}' already exists — moves never overwrite. Pick a different name, or request deletion of the existing asset first.`,
					};
				}
				throw e;
			}
			broadcastRowChange(wsManager, wsRoom.team(scope.teamId), 'assets', 'UPDATE', {
				id: assetId,
				team_id: scope.teamId,
				project_id: scope.projectId,
				original_filename: to,
			});
			return {
				moved: true,
				id: assetId,
				from: `assets/${from}`,
				reference: `assets/${to}`,
				note: 'Existing text references to the old path no longer link — update comments/docs that cite it.',
			};
		},
		db,
	);

	tool(
		server,
		'copy_project_asset',
		'Copy a project asset to a new path in the assets library (any type, including binary). The copy is a new asset with its own id; the source is untouched and existing references keep pointing at it. Copies never overwrite: if the destination path is taken the call fails. Use it to duplicate a template before editing, or to stage related files into a folder.',
		{
			project: projectArg(),
			from: z.string().describe('Source asset path (e.g. "templates/report.md")'),
			to: z.string().describe('Destination path (e.g. "2026-q3/report.md")'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const from = normalizeAssetPath(args.from as string);
			if (from === null) return { error: assetPathError(args.from as string) };
			const to = normalizeAssetPath(args.to as string);
			if (to === null) return { error: assetPathError(args.to as string) };
			if (from === to) return { error: 'Source and destination are the same path.' };
			const found = await db.query<{ id: string; content_type: string }>(
				'SELECT id, content_type FROM assets WHERE project_id = $1 AND original_filename = $2',
				[scope.projectId, from],
			);
			if (found.rows.length === 0) return { error: `Asset 'assets/${from}' not found` };
			const source = found.rows[0];

			const { teamId, projectId } = scope;
			const buf = await readAsset(dataDir, teamId, projectId, source.id);
			const assetId = crypto.randomUUID();
			const { byteSize, sha256 } = await writeAsset(
				dataDir,
				teamId,
				projectId,
				assetId,
				new Blob([new Uint8Array(buf)]),
			);
			const uploadedBy = auth.type === AuthType.Agent ? auth.memberId : null;
			let inserted: { id: string; original_filename: string };
			try {
				const r = await db.query<{ id: string; original_filename: string }>(
					`INSERT INTO assets (id, team_id, project_id, content_type, byte_size, sha256, original_filename, uploaded_by_member_id)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
					 RETURNING id, original_filename`,
					[assetId, teamId, projectId, source.content_type, byteSize, sha256, to, uploadedBy],
				);
				inserted = r.rows[0];
			} catch (e) {
				await deleteAsset(dataDir, teamId, projectId, assetId).catch(() => {});
				if (isUniqueViolation(e)) {
					return {
						error: `Destination 'assets/${to}' already exists — copies never overwrite. Pick a different name.`,
					};
				}
				throw e;
			}
			events?.emit({
				type: 'asset.created',
				teamId,
				projectId,
				actorType: actorTypeFromAuth(auth),
				actorMemberId: uploadedBy,
				actorApiKeyId: apiKeyIdFromAuth(auth),
				assetId: inserted.id,
				filename: inserted.original_filename,
				taskId: auth.type === AuthType.Agent ? auth.taskId : null,
				runId: auth.type === AuthType.Agent ? auth.runId : null,
			});
			broadcastRowChange(wsManager, wsRoom.team(teamId), 'assets', 'INSERT', {
				id: inserted.id,
				team_id: teamId,
				project_id: projectId,
				original_filename: inserted.original_filename,
			});
			return { copied: true, id: inserted.id, reference: `assets/${to}` };
		},
		db,
	);

	tool(
		server,
		'request_asset_deletion',
		'Ask a human admin to approve deleting one or more project assets. Deletion is destructive, so agents can never delete directly — this posts an approval card on the task; an admin approves or denies it, on approval the backend deletes the assets (rows, attachments, and stored bytes; no further agent action needed), and you are woken with the outcome. Stop any work that depends on the deletion and wait. Everything short of deletion — create, overwrite, read, list, copy, move — is self-serve; consider moving obsolete-but-maybe-valuable assets into an archive folder (move_project_asset) instead of requesting deletion.',
		{
			project: projectArg(),
			task_id: z
				.string()
				.describe(
					'Task identifier or UUID — the approval card is posted here (usually your current task)',
				),
			filenames: z
				.array(z.string())
				.min(1)
				.describe(
					'Asset paths to delete — full paths exactly as list_project_assets returns them (e.g. ["drafts/old-v1.md", "old-logo.png"])',
				),
			reason: z
				.string()
				.describe('Why these assets should be deleted — shown to the approving admin'),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, projectId, taskId } = scope;

			const raw = args.filenames as string[];
			const paths: string[] = [];
			for (const f of raw) {
				const normalized = normalizeAssetPath(f);
				if (normalized === null) return { error: assetPathError(f) };
				if (!paths.includes(normalized)) paths.push(normalized);
			}
			const found = await db.query<{ id: string; original_filename: string }>(
				'SELECT id, original_filename FROM assets WHERE project_id = $1 AND original_filename = ANY($2::text[])',
				[projectId, paths],
			);
			const foundByPath = new Map(found.rows.map((r) => [r.original_filename, r.id]));
			const missing = paths.filter((p) => !foundByPath.has(p));
			if (missing.length > 0) {
				return {
					error: `Not found: ${missing.map((p) => `assets/${p}`).join(', ')} — nothing was requested (all-or-nothing). Check list_project_assets for the exact paths.`,
				};
			}
			const assets = paths.map((p) => ({ id: foundByPath.get(p) as string, path: p }));
			const idsKey = assets
				.map((a) => a.id)
				.sort()
				.join(',');

			// Idempotency: an identical pending request on this task is reused, so a
			// retried run doesn't stack duplicate approval cards.
			const pendingRows = await db.query<{
				id: string;
				content: { assets?: Array<{ id: string }> };
			}>(
				`SELECT id, content FROM task_comments
				 WHERE task_id = $1
				   AND content_type = 'asset_deletion_request'::comment_content_type
				   AND chosen_option IS NULL
				 ORDER BY created_at ASC`,
				[taskId],
			);
			for (const row of pendingRows.rows) {
				const existingIds = (row.content.assets ?? [])
					.map((a) => a.id)
					.sort()
					.join(',');
				if (existingIds === idsKey) {
					return { comment_id: row.id, status: 'pending', reused: true };
				}
			}

			const reason = args.reason as string;
			const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const refs = assets.map((a) => `assets/${a.path}`).join(', ');
			const content = {
				assets,
				reason,
				// The inbox snippet builder reads content.text; keep it human-readable.
				text: `Requested deletion of ${assets.length} asset${assets.length === 1 ? '' : 's'}: ${refs} — ${reason}`,
			};
			const inserted = await db.query<{ id: string }>(
				`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
				 VALUES ($1, $2, 'asset_deletion_request'::comment_content_type, $3::jsonb)
				 RETURNING *`,
				[taskId, authorMemberId, JSON.stringify(content)],
			);
			broadcastCommentFamilyChange(
				wsManager,
				teamId,
				projectId,
				'task_comments',
				'INSERT',
				inserted.rows[0] as unknown as Record<string, unknown>,
			);

			// Deletion requests must reach a human who can act — raise the admin
			// inbox badge even though the card carries no literal @admin text.
			try {
				await fireAdminMention({
					db,
					teamId,
					taskId,
					commentId: inserted.rows[0].id,
					authorUserId: null,
					wsManager,
				});
			} catch (e) {
				log.error('Failed to fan out asset-deletion admin mention:', e);
			}

			events?.emit({
				type: 'asset.deletion_requested',
				teamId,
				projectId,
				actorType: actorTypeFromAuth(auth),
				actorMemberId: authorMemberId,
				actorApiKeyId: apiKeyIdFromAuth(auth),
				commentId: inserted.rows[0].id,
				taskId,
				assetIds: assets.map((a) => a.id),
				filenames: assets.map((a) => a.path),
			});

			return {
				comment_id: inserted.rows[0].id,
				status: 'pending',
				reused: false,
				assets: assets.map((a) => `assets/${a.path}`),
				note: 'An admin must approve the deletion. Stop work that depends on it and wait — you will be woken with the outcome.',
			};
		},
		db,
	);

	tool(
		server,
		'read_project_doc',
		'Read a markdown project doc by filename (e.g. "spec.md") — the high-level project context (PRDs, specs, architecture decisions, research) that list_project_docs returns; the full body comes back inline as `content`. These docs live in the project-doc store in the database, NOT on the filesystem: there is no /workspace/.hezo/project-docs path, so do not reach for the Read/cat file tools — always load a doc through this tool by its bare filename. When the admin has left review feedback on the doc, the result includes `review_comments` — each anchors a `comment` to a `quote` (an exact text snippet; `occurrence` disambiguates repeated snippets). Action them when asked to. IMPORTANT: any write to the doc deletes ALL of its review comments, so capture every comment from this result BEFORE your first write_project_doc call — after one write they are gone. For non-markdown assets (mockups, wireframes, diagrams) use read_project_asset instead.',
		{
			project: projectArg(),
			filename: z.string().describe('Filename to read (e.g. "spec.md")'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const doc = await getDocument(db, {
				type: DocumentType.ProjectDoc,
				teamId: scope.teamId,
				projectId: scope.projectId,
				slug: args.filename as string,
			});
			if (!doc) return { error: `File '${args.filename}' not found` };
			const reviewComments = await listReviewComments(db, doc.id);
			if (reviewComments.length === 0) return { filename: doc.slug, content: doc.content };
			return {
				filename: doc.slug,
				content: doc.content,
				review_comments: reviewComments.map((r) => ({
					id: r.id,
					quote: r.quote,
					occurrence: r.occurrence,
					comment: r.comment,
					created_at: r.created_at,
				})),
			};
		},
		db,
	);

	tool(
		server,
		'write_project_doc',
		"Write a project documentation file. Project docs are markdown only — the filename must end in .md. For high-level project context: PRD, spec, implementation plan, research. Make ALL desired edits in ONE consolidated write per run, for two reasons: (1) writing a doc deletes ALL of its pending review comments (the admin's highlight feedback returned by read_project_doc) — a single write clears the whole review, so capture every comment in your context before the first write; (2) docs are revisioned — every content-changing write records a revision, so many partial writes bury the history in noise. Pass a `changelog` summarizing what changed in this write and why — it becomes that revision's entry in the document's history; keep status headers and update/changelog logs OUT of the document body and put them in `changelog` instead. Non-markdown files (mockups, wireframes, images, PDFs) live in the project assets library instead — reference those as `assets/<filename>`. In content, reference teammates with @<agent-slug>. Reference tickets and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug — no @ prefix. Do not wrap any of these in backticks — that makes them inert.",
		{
			project: projectArg(),
			filename: z.string().describe('Markdown filename to write (e.g. "spec.md")'),
			content: z.string().describe('File content (markdown)'),
			changelog: z
				.string()
				.optional()
				.describe(
					"Markdown summary of what changed in THIS update and why — recorded as the revision's changelog and shown in the document's revision history. Put update/status notes here, never in the document body. Reference tickets/docs/agents by bare identifier as in content.",
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			if (!isMarkdownDocSlug(args.filename as string)) {
				return {
					error:
						'Project docs must be markdown (.md). Non-markdown files belong in the assets library, referenced as assets/<filename>.',
				};
			}
			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const callerApiKeyId = apiKeyIdFromAuth(auth);
			const doc = await upsertDocument(db, wsManager, {
				scope: {
					type: DocumentType.ProjectDoc,
					teamId: scope.teamId,
					projectId: scope.projectId,
					slug: args.filename as string,
				},
				content: args.content as string,
				changeSummary: args.changelog as string | undefined,
				authorMemberId: callerMemberId,
				authorApiKeyId: callerApiKeyId,
				audit: {
					events,
					actorType: actorTypeFromAuth(auth),
					actorApiKeyId: callerApiKeyId,
				},
			});
			return { written: true, id: doc.id, filename: doc.slug };
		},
		db,
	);

	tool(
		server,
		'update_chat_memory',
		"Replace your long-term chat memory — the durable notes carried into every turn of your live operator chat. Pass the FULL revised markdown; it overwrites the stored memory wholesale (there is no append). Record durable, standing knowledge only: operator preferences, decisions, and a rough gist of off-project threads. Do NOT store live data you can re-fetch each turn (project/ticket/roster state). Memory is compacted automatically when the conversation window fills — you'll be handed the window and asked to fold it in via this tool — but you may also call it any time to record something standing.",
		{
			content: z.string().describe('The full long-term memory markdown (replaces existing memory)'),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent || !auth.memberId) {
				return {
					error: 'update_chat_memory can only be called by an agent updating its own memory',
				};
			}
			const mem = await upsertChatMemory(db, auth.memberId, args.content as string);
			return { written: true, updated_at: mem.updated_at };
		},
		db,
	);

	// Skill proposals
	tool(
		server,
		'propose_skill',
		"Propose a new skill for the team's skills database (reusable team know-how: MCP server usage, integration steps, conventions, how agents coordinate). Creates an approval request; when approved the skill is written to the skills database.",
		{
			project: projectArg(),
			skill_name: z.string().describe('Human-readable skill name'),
			skill_slug: z.string().describe('URL-safe slug for the skill file'),
			content: z.string().describe('Skill content (markdown)'),
			reason: z.string().describe('Why this skill should be added'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const teamId = scope.teamId;
			const result = await db.query<Record<string, unknown>>(
				`INSERT INTO approvals (team_id, type, requested_by_member_id, payload)
				 VALUES ($1, $2::approval_type, $3, $4::jsonb)
				 RETURNING ${APPROVAL_COLUMNS}`,
				[
					teamId,
					ApprovalType.SkillProposal,
					callerMemberId,
					JSON.stringify({
						skill_name: args.skill_name,
						skill_slug: args.skill_slug,
						content: args.content,
						reason: args.reason,
					}),
				],
			);
			const row = result.rows[0];
			if (row) {
				broadcastApprovalChange(wsManager, teamId, 'INSERT', row);
			}
			return { approval_id: row?.id, status: row?.status };
		},
		db,
	);

	// Full-text search
	tool(
		server,
		'semantic_search',
		'Full-text keyword search across the team skills database, tasks, project docs, and task comments. Returns results ranked by relevance (keyword + stemming match).',
		{
			project: projectArg(),
			query: z.string().describe('Search query (keywords)'),
			scope: z
				.enum(SEARCH_SCOPES)
				.optional()
				.describe('Limit search to specific content type (default: all)'),
			limit: z.number().optional().describe('Max results per type (default: 10)'),
		},
		async (args, db, auth) => {
			const projectScope = await resolveScope(db, auth, args);
			if ('error' in projectScope) return projectScope;

			const { fullTextSearch } = await import('../services/search');
			const results = await fullTextSearch(db, [projectScope.teamId], args.query as string, {
				scope: (args.scope as SearchScope) ?? 'all',
				limit: (args.limit as number) ?? 10,
			});

			return { results, count: results.length };
		},
		db,
	);

	// Skills - DB-backed CRUD
	tool(
		server,
		'list_skills',
		"List the team's skills database — the manifest of reusable team know-how (MCP server usage, integration steps, conventions, how agents coordinate). Returns each skill's name, slug, and description; call get_skill to load a skill's full body on demand.",
		{
			project: projectArg(),
			tags: z.string().optional().describe('Filter by tag (comma-separated)'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			let query = `SELECT id, name, slug, description, tags, created_at, updated_at
			             FROM skills WHERE is_active = true`;
			const params: unknown[] = [];

			if (args.tags) {
				const tagList = (args.tags as string).split(',').map((t) => t.trim());
				query += ` AND tags ?| $1`;
				params.push(tagList);
			}

			query += ' ORDER BY name';
			const result = await db.query(query, params);
			return { skills: result.rows };
		},
		db,
	);

	tool(
		server,
		'get_skill',
		"Load the full body of a skill from the team's skills database by slug. Use after list_skills surfaces a relevant skill in the manifest.",
		{
			project: projectArg(),
			slug: z.string().describe('Skill slug'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const result = await db.query(`SELECT ${SKILL_COLUMNS} FROM skills WHERE slug = $1 LIMIT 1`, [
				args.slug,
			]);
			if (result.rows.length === 0) return { error: 'Skill not found' };
			return result.rows[0];
		},
		db,
	);

	tool(
		server,
		'create_skill',
		"Add or update a skill in the team's skills database directly (no approval needed) — record reusable team know-how such as MCP server usage, integration steps, conventions, and how agents coordinate. Use propose_skill when approval is required. If description is omitted it is derived from the skill body.",
		{
			project: projectArg(),
			name: z.string().describe('Human-readable skill name'),
			slug: z.string().describe('URL-safe slug'),
			content: z.string().describe('Skill content (markdown)'),
			description: z.string().optional().describe('Short description'),
			tags: z.string().optional().describe('Comma-separated tags'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const { createHash } = await import('node:crypto');
			const contentHash = createHash('sha256')
				.update(args.content as string)
				.digest('hex');
			const tagList = args.tags ? (args.tags as string).split(',').map((t) => t.trim()) : [];
			// Backfill the manifest description from the body when omitted, so the
			// per-run skills manifest always has a usable one-line summary.
			const description =
				(args.description as string)?.trim() || deriveSkillSummary(args.content as string);

			const priorSkill = await db.query<{ content: string }>(
				'SELECT content FROM skills WHERE slug = $1',
				[args.slug],
			);

			const result = await db.query<{ id: string; slug: string }>(
				`INSERT INTO skills (name, slug, description, content, content_hash, created_by_member_id, tags)
				 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
				 ON CONFLICT (slug) DO UPDATE SET
				   content = EXCLUDED.content,
				   content_hash = EXCLUDED.content_hash,
				   description = EXCLUDED.description,
				   tags = EXCLUDED.tags,
				   updated_at = now()
				 RETURNING id, slug`,
				[
					args.name,
					args.slug,
					description,
					args.content,
					contentHash,
					callerMemberId,
					JSON.stringify(tagList),
				],
			);

			const skillId = result.rows[0].id;
			await recordSkillRevisionIfChanged(
				db,
				skillId,
				priorSkill.rows[0]?.content ?? null,
				args.content as string,
				'Updated via MCP',
				callerMemberId,
			);

			return { skill_id: skillId, slug: result.rows[0].slug, created: true };
		},
		db,
	);

	tool(
		server,
		'list_mcp_connections',
		'List the MCP server connections available to agent runs (instance-global — the same catalog for every team). Each row includes a derived `oauth_status` so you can tell whether a connector is usable: "active" means OAuth completed and the MCP tools should appear in your tool list on your next run; "pending" means waiting on the human to click Connect; "failed" means the OAuth flow errored (see auth_error); "revoked" means a human disconnected it; "none" means no OAuth needed (e.g., an env-var-token MCP or a public one). Do NOT confuse `install_status` (which tracks local-package install state and is meaningless for SaaS MCPs) with `oauth_status`. An active OAuth-backed connector also carries `rest_auth` = `{ placeholder, allowed_hosts, scopes }`: put `placeholder` (e.g. in an `Authorization: Bearer <placeholder>` header) on a raw HTTP request to authenticate the provider\'s REST API directly when no MCP tool covers what you need — the egress proxy substitutes the real token, but ONLY for requests to `allowed_hosts`; you never see the value. Use this instead of requesting a PAT (e.g. for GitHub repo-settings edits that the `github` MCP does not expose).',
		{
			project: projectArg(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const r = await db.query<{
				id: string;
				name: string;
				display_name: string | null;
				kind: string;
				config: Record<string, unknown>;
				oauth_connection_id: string | null;
				install_status: string;
				install_error: string | null;
				skill_id: string | null;
				created_by_task_id: string | null;
				activated_at: string | null;
				revoked_at: string | null;
				auth_error: string | null;
				created_at: string;
				updated_at: string;
				oauth_secret_name: string | null;
				oauth_allowed_hosts: string[] | null;
				oauth_scopes: string[] | null;
			}>(
				`SELECT mc.id, mc.name, mc.display_name, mc.kind::text AS kind,
				        mc.config, mc.oauth_connection_id, mc.install_status::text AS install_status, mc.install_error,
				        mc.skill_id, mc.created_by_task_id,
				        mc.activated_at::text AS activated_at, mc.revoked_at::text AS revoked_at, mc.auth_error,
				        mc.created_at::text, mc.updated_at::text,
				        s.name AS oauth_secret_name, s.allowed_hosts AS oauth_allowed_hosts, oc.scopes AS oauth_scopes
				 FROM mcp_connections mc
				 LEFT JOIN oauth_connections oc ON oc.id = mc.oauth_connection_id
				 LEFT JOIN secrets s ON s.id = oc.access_token_secret_id
				 ORDER BY mc.name ASC`,
			);
			// Derive a single oauth_status field that's the load-bearing signal
			// for whether the connector is usable by agents on subsequent runs.
			const cfg = (row: { config: Record<string, unknown> }): boolean => {
				const c = row.config as { dcr?: unknown };
				return !!c?.dcr;
			};
			return r.rows.map((row) => {
				let oauth_status: 'active' | 'pending' | 'failed' | 'revoked' | 'none';
				if (row.kind !== 'saas') oauth_status = 'none';
				else if (row.revoked_at) oauth_status = 'revoked';
				else if (row.auth_error && !row.activated_at) oauth_status = 'failed';
				else if (row.oauth_connection_id && row.activated_at) oauth_status = 'active';
				else if (cfg(row) || row.created_by_task_id) oauth_status = 'pending';
				else oauth_status = 'none';

				// An active OAuth-backed connector can also authenticate raw REST calls
				// to the provider's API: expose the secret's placeholder (never its
				// value) plus the hosts the egress proxy will substitute it for, so an
				// agent can hit endpoints the MCP server doesn't cover without ever
				// requesting a PAT. Omitted unless the token is scoped to at least one
				// host, since an unscoped secret can never be substituted.
				const { oauth_secret_name, oauth_allowed_hosts, oauth_scopes, ...rest } = row;
				const rest_auth =
					oauth_status === 'active' && oauth_secret_name && (oauth_allowed_hosts?.length ?? 0) > 0
						? {
								placeholder: credentialPlaceholder(oauth_secret_name),
								allowed_hosts: oauth_allowed_hosts ?? [],
								scopes: oauth_scopes ?? [],
							}
						: null;
				return { ...rest, oauth_status, rest_auth };
			});
		},
		db,
	);

	tool(
		server,
		'test_connector',
		'Test an MCP connector end-to-end from the server side. Resolves the stored OAuth token from the vault and makes a direct HTTP call to the MCP server (bypassing the agent container and its egress proxy entirely). Returns the upstream status code, response excerpt, and the secret name + masked-token-prefix used. Use this when oauth_status says "active" but the MCP\'s tools are absent from your tool list — it isolates "is the token still valid against the provider?" from "does the proxy chain in the container work?".',
		{
			project: projectArg(),
			connector_id: z.string().describe('mcp_connections.id from list_mcp_connections'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const connectorId = args.connector_id as string;

			const row = await db.query<{
				id: string;
				name: string;
				kind: string;
				config: Record<string, unknown>;
				oauth_connection_id: string | null;
			}>(
				`SELECT id, name, kind::text AS kind, config, oauth_connection_id
				 FROM mcp_connections WHERE id = $1`,
				[connectorId],
			);
			if (row.rows.length === 0) return { error: 'connector not found' };
			const connector = row.rows[0];
			if (connector.kind !== 'saas') {
				return { error: `connector kind=${connector.kind}; test only meaningful for kind=saas` };
			}
			const config = connector.config as { url?: string };
			if (!config.url) return { error: 'connector has no mcp url' };

			let bearerToken: string | null = null;
			let secretName: string | null = null;
			let tokenPrefix: string | null = null;
			if (connector.oauth_connection_id) {
				const secret = await db.query<{ name: string; encrypted_value: string }>(
					`SELECT s.name, s.encrypted_value FROM oauth_connections oc
					 JOIN secrets s ON s.id = oc.access_token_secret_id
					 WHERE oc.id = $1`,
					[connector.oauth_connection_id],
				);
				if (secret.rows.length === 0) {
					return {
						error:
							'oauth_connection_id is set but no matching secret row found — vault is corrupted for this connector',
						connector_id: connector.id,
						oauth_connection_id: connector.oauth_connection_id,
					};
				}
				const key = masterKeyManager.getKey();
				if (!key) return { error: 'master key is locked; cannot decrypt secret to test' };
				const { decrypt } = await import('../crypto/encryption');
				try {
					bearerToken = decrypt(secret.rows[0].encrypted_value, key);
				} catch (e) {
					return {
						error: `failed to decrypt stored token: ${(e as Error).message}`,
						secret_name: secret.rows[0].name,
					};
				}
				secretName = secret.rows[0].name;
				tokenPrefix = bearerToken.slice(0, 8);
			}

			const headers: Record<string, string> = { Accept: 'application/json' };
			if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

			let probeRes: Response;
			try {
				probeRes = await fetch(config.url, { method: 'GET', headers });
			} catch (e) {
				return {
					ok: false,
					error: `network probe failed: ${(e as Error).message}`,
					mcp_url: config.url,
					secret_name: secretName,
					token_prefix: tokenPrefix,
				};
			}
			const bodyText = await probeRes.text().catch(() => '');
			const wwwAuth = probeRes.headers.get('WWW-Authenticate') ?? null;
			return {
				ok: probeRes.ok,
				status: probeRes.status,
				mcp_url: config.url,
				secret_name: secretName,
				token_prefix: tokenPrefix,
				token_length: bearerToken?.length ?? 0,
				www_authenticate: wwwAuth,
				body_excerpt: bodyText.slice(0, 400),
				hint:
					probeRes.status === 401
						? bearerToken
							? 'Token rejected by upstream. Either the token expired, the scopes are insufficient, or the provider revoked it. Surface to the user; they may need to reconnect.'
							: 'No token sent (connector has no oauth_connection_id). OAuth never completed for this connector.'
						: probeRes.ok
							? "Token valid against upstream. If the MCP tools still don't appear in your tool list, the issue is in the container/proxy chain — file a bug with the launch-command headers and any audit_log entries for this host."
							: `Upstream returned ${probeRes.status}; check body_excerpt for details.`,
			};
		},
		db,
	);

	tool(
		server,
		'add_mcp_connection',
		"Register an MCP server (SaaS HTTP or local stdio). Connections are instance-global — available to every team's agent runs. SaaS servers go into the agent's descriptor list immediately. Header values may include __HEZO_SECRET_<NAME>__ placeholders that the egress proxy substitutes at request time. Local servers must be installed before they take effect.",
		{
			project: projectArg(),
			name: z
				.string()
				.trim()
				.min(1, 'name is required')
				.describe('Server identifier — used as the MCP descriptor name and as the unique key.'),
			kind: z.enum(['saas', 'local']).describe('saas = HTTP MCP, local = stdio MCP'),
			config: z
				.record(z.string(), z.unknown())
				.describe('For saas: { url, headers? }. For local: { command, args?, env?, package? }.'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			// name non-empty enforced by the schema; kind is a schema enum.
			const name = (args.name as string).trim();
			const kind = args.kind as 'saas' | 'local';
			const config = args.config as Record<string, unknown>;

			if (kind === 'saas') {
				if (!config?.url || typeof config.url !== 'string') {
					return { error: 'saas connections require config.url (string)' };
				}
			} else {
				if (!config?.command || typeof config.command !== 'string') {
					return { error: 'local connections require config.command (string)' };
				}
			}

			const initialStatus = kind === 'saas' ? 'installed' : 'pending';
			const r = await db.query<{
				id: string;
				install_status: string;
			}>(
				`INSERT INTO mcp_connections (name, kind, config, install_status)
				 VALUES ($1, $2::mcp_connection_kind, $3::jsonb, $4::mcp_install_status)
				 ON CONFLICT (name) DO UPDATE
				 SET kind = EXCLUDED.kind,
				     config = EXCLUDED.config,
				     install_status = EXCLUDED.install_status,
				     install_error = NULL,
				     updated_at = now()
				 RETURNING id, install_status::text AS install_status`,
				[name, kind, JSON.stringify(config), initialStatus],
			);
			return {
				id: r.rows[0].id,
				install_status: r.rows[0].install_status,
				note:
					kind === 'local'
						? 'Local MCP registered with status pending. Install via the installer or container provision before agent runs can use it.'
						: 'SaaS MCP registered. Will be available to the next agent run in this scope.',
			};
		},
		db,
	);

	tool(
		server,
		'remove_mcp_connection',
		'Remove a registered MCP connection (instance-global — removing it affects every team). The next agent run will not see it.',
		{
			project: projectArg(),
			id: z
				.string()
				.describe('mcp_connections.id (returned by add_mcp_connection or list_mcp_connections)'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const r = await db.query<{ id: string }>(
				'DELETE FROM mcp_connections WHERE id = $1 RETURNING id',
				[args.id as string],
			);
			if (r.rows.length === 0) return { error: 'MCP connection not found' };
			return { removed: true, id: r.rows[0].id };
		},
		db,
	);

	return [...registeredTools];
}

/**
 * Whether the caller may perform team-coordination writes (summaries, team
 * contexts, prompts) for `teamId`. True for the team's own Captain and for any
 * HQ virtual member running inside the team — the latter covers the CEO/Coach
 * doing cross-team setup and coherence work.
 */
async function canCoordinateTeam(db: PGlite, auth: AuthInfo, teamId: string): Promise<boolean> {
	if (auth.type !== AuthType.Agent) return false;
	if (await isVirtualHqMemberInTeam(db, auth, teamId)) return true;
	const r = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE ma.id = $1 AND m.team_id = $2`,
		[auth.memberId, teamId],
	);
	return r.rows[0]?.slug === CAPTAIN_AGENT_SLUG;
}

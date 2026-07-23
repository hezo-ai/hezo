import { AsyncLocalStorage } from 'node:async_hooks';
import type { SearchScope } from '@hezo/shared';
import {
	AgentAdminStatus,
	ApprovalStatus,
	ApprovalType,
	ArchiveFilter,
	ASSET_MAX_FOLDER_DEPTH,
	AssetSortOrder,
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
	ConnectorTransport,
	CredentialInputType,
	CredentialKind,
	credentialKindRequiresAllowedHosts,
	DEFAULT_TEAM_ID,
	DocumentType,
	extensionOf,
	extractBacktickedLooseAssetPaths,
	extractBacktickedMentionCandidates,
	type GoalHealth,
	getConnectorCapability,
	hasFixedReportsTo,
	INSTANCE_AGENT_SLUGS,
	isAllowedAttachmentMime,
	isMarkdownDocSlug,
	isTextAssetMime,
	matchesArchiveFilter,
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
import { LocalAssetStore } from '../assets/drivers/local';
import type { AssetStore } from '../assets/store';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import type { DomainEventBus } from '../events/bus';
import { assertNoActiveRun } from '../lib/active-run';
import { isHqInstanceAgent, isVirtualHqMemberInTeam } from '../lib/agent-roles';
import { upsertProjectAsset } from '../lib/asset-name';
import { assetSortOrderBy } from '../lib/asset-sort';
import { signAgentAssetUrl } from '../lib/asset-urls';
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
import { readImageDimensions } from '../lib/image-dimensions';
import {
	detectPassiveTeammateAsks,
	detectUnlinkedTeammateReferences,
	extractMentionSlugs,
} from '../lib/mentions';
import {
	actorTypeFromAuth,
	apiKeyIdFromAuth,
	resolveActorMemberId,
	resolveAgentId,
	resolveAssigneeId,
	resolveProject,
	resolveReactorMemberId,
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
import { loadAgentAttachmentsForComments } from '../services/agent-runner';
import {
	AgentSystemPromptError,
	fetchAgentSystemPromptForBatch,
	type SystemPromptMode,
} from '../services/agent-system-prompts';
import { broadcastApprovalChange } from '../services/approval-broadcast';
import { resolveApproval } from '../services/approval-resolve';
import { upsertChatMemory } from '../services/chat-memory';
import {
	fireCommentWakeups,
	postAgentComment,
	resolveWarnableSlugs,
} from '../services/comment-wakeups';
import {
	buildConnectorRecipesSkill,
	CONNECTOR_RECIPES_SLUG,
	isConnectorRecipesSlug,
	resolveConnectorRegistry,
} from '../services/connector-registry';
import { validateApiConnectorConfig } from '../services/connectors/connections';
import type { ContainerDeps } from '../services/containers';
import { enqueueTeamCoherenceReviewTask } from '../services/description-tasks';
import {
	getAgentSystemPrompt,
	getDocument,
	listDocuments,
	setDocumentArchived,
	upsertDocument,
} from '../services/documents';
import {
	type GoalSuggestionPayload,
	insertGoalSuggestionApproval,
	insertGoalSuggestionComment,
} from '../services/goal-suggestion';
import { listGoals, recordGoalProgress } from '../services/goals';
import {
	buildHirePayloadPatch,
	type HirePayloadPatchInput,
	type HireProposalInput,
	insertHireApproval,
	prepareHireProposal,
} from '../services/hire-proposal';
import { insertHireProposalComment } from '../services/hire-proposal-comment';
import { getMarketplaceTeam } from '../services/marketplace';
import { createProjectWithTeam } from '../services/project-create';
import { completeProjectIntakeAfterProvisioning } from '../services/project-intake';
import { ProjectProgressError, updateProjectProgress } from '../services/projects';
import {
	addCommentReaction,
	loadReactionsForTask,
	removeCommentReaction,
} from '../services/reactions';
import { listReviewComments } from '../services/review-comments';
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
import { applyMarketplaceTeamToTeam } from '../services/team-template-apply';
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
// cleanly. Read-only tools (list_*/get_*/read_*/full_text_search/test_connector)
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
	'register_connector',
	'resolve_approval',
	'update_agent_system_prompt',
	'update_agent_system_prompts',
	'set_agent_status',
	'set_agent_summary',
	'set_team_summary',
	'set_agent_team_context',
	'set_agent_reports_to',
	'write_project_asset',
	'move_project_asset',
	'copy_project_asset',
	'archive_project_asset',
	'unarchive_project_asset',
	'write_project_doc',
	'archive_project_doc',
	'unarchive_project_doc',
	'update_chat_memory',
	'propose_skill',
	'create_skill',
	'add_connector',
	'remove_connector',
	'suggest_goal',
	'update_goal_progress',
	'update_project_progress',
	'update_project_custom_prompt',
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
	db: Db,
	teamId: string,
	authorMemberId: string,
	content: string,
): Promise<string | null> {
	const knownSlugs = await resolveWarnableSlugs(db, teamId, authorMemberId);
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
 * Returns a warning when a comment addresses a teammate with the PASSIVE mention
 * form (@@slug) yet the surrounding text reads like an ask — the passive form
 * links but notifies no one, so an intended handoff stalls silently. Only an
 * addressing use paired with a directed-ask signal is flagged (see
 * detectPassiveTeammateAsks), so a deliberate passive reference is left alone.
 * Same scoping as buildUnlinkedMentionWarning; best-effort and non-blocking.
 */
async function buildPassiveMentionWarning(
	db: Db,
	teamId: string,
	authorMemberId: string,
	content: string,
): Promise<string | null> {
	const knownSlugs = await resolveWarnableSlugs(db, teamId, authorMemberId);
	const offenders = detectPassiveTeammateAsks(content, knownSlugs);
	if (offenders.length === 0) return null;
	const named = offenders.map((s) => `@@${s}`).join(', ');
	const fixes = offenders.map((s) => `@${s}`).join(', ');
	return (
		`You addressed ${named} with the passive form (@@) but the text reads like an ask — ` +
		`that renders as a link and notifies no one, so no wakeup or admin-inbox alert was ` +
		`created. If you need them to act on this ticket, edit this comment or post a follow-up ` +
		`with an active mention (${fixes}); if you only meant to refer to them, leave the ` +
		`passive form as-is.`
	);
}

/**
 * Returns a warning when markdown wraps a Hezo reference in inline backticks —
 * which renders it as inert code instead of a link — or null when nothing is
 * amiss. Tasks, project docs/skills, and teammates are flagged only when they
 * actually resolve (a real task in this team, a project doc/skill, or a teammate
 * in this team or HQ), so genuine code spans — repo paths, package names,
 * `UTF-8` — never trip those branches. An `assets/<path>` reference is the
 * exception: the `assets/` prefix is unambiguously a Hezo asset handle (never a
 * repo path), so a backticked one is flagged whether or not the asset exists
 * yet — catching a deliverable an agent is about to create before the backtick
 * habit sets.
 *
 * A second asset failure is caught here too: an asset referenced by a
 * folder-prefixed path that BOTH sits in backticks AND drops the `assets/`
 * prefix (e.g. `` `diagrams/hero.svg` `` for `assets/diagrams/hero.svg`). That
 * form matches neither the mention regex (it requires the literal `assets/`
 * prefix) nor a bare-filename branch, so without this it linked nowhere and
 * warned nowhere. Because a prefix-less folder path is genuinely ambiguous with
 * a repo file, it is resolve-gated — flagged only when it matches a real asset's
 * stored `original_filename` in this project — and the fix restores the prefix.
 * Best-effort and non-blocking, exactly like buildUnlinkedMentionWarning.
 */
async function buildBacktickedEntityWarning(
	db: Db,
	teamId: string,
	projectId: string,
	content: string,
): Promise<string | null> {
	const candidates = extractBacktickedMentionCandidates(content);
	const looseAssetPaths = extractBacktickedLooseAssetPaths(content);
	if (
		candidates.tasks.length === 0 &&
		candidates.filenames.length === 0 &&
		candidates.assets.length === 0 &&
		candidates.agents.length === 0 &&
		looseAssetPaths.length === 0
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
			`SELECT slug FROM skills
			 WHERE LOWER(slug) = ANY($1::text[]) AND (project_id = $2 OR project_id IS NULL)`,
			[candidates.filenames.map((f) => f.toLowerCase()), projectId],
		);
		for (const row of kb.rows) refs.push(row.slug);
	}

	// The `assets/` prefix is unambiguously a Hezo asset handle, never a repo
	// path, so a backticked asset reference is always wrong — flag every candidate
	// without a DB existence check. This is what catches a deliverable an agent is
	// about to create (the asset row doesn't exist yet), where the resolve-gated
	// branches above would stay silent.
	for (const a of candidates.assets) refs.push(`assets/${a}`);

	// Backticked asset paths that ALSO dropped the `assets/` prefix. A prefix-less
	// folder path is ambiguous with a real repo file, so resolve-gate it against
	// the project's assets (matched on `original_filename`, which is stored without
	// the prefix) and flag only genuine hits — the fix restores the prefix.
	const looseAssetFixes: string[] = [];
	if (looseAssetPaths.length > 0) {
		const r = await db.query<{ original_filename: string }>(
			`SELECT original_filename FROM assets WHERE project_id = $1 AND original_filename = ANY($2::text[])`,
			[projectId, looseAssetPaths],
		);
		for (const row of r.rows) looseAssetFixes.push(row.original_filename);
	}

	if (refs.length === 0 && looseAssetFixes.length === 0) return null;

	const parts: string[] = [];
	if (refs.length > 0) {
		const deduped = Array.from(new Set(refs));
		const wrapped = deduped.map((ref) => `\`${ref}\``).join(', ');
		const bare = deduped.join(', ');
		parts.push(
			`You wrapped Hezo reference(s) in backticks — ${wrapped} — so they render as inert ` +
				`code instead of links. Write each bare (no backticks): ${bare}. A bare reference links ` +
				`as soon as its target exists — an \`assets/<path>\` you have not created yet renders as ` +
				`plain text until then, then links automatically — whereas backticks keep it inert ` +
				`permanently.`,
		);
	}
	if (looseAssetFixes.length > 0) {
		const deduped = Array.from(new Set(looseAssetFixes));
		const pairs = deduped.map((p) => `\`${p}\` → assets/${p}`).join(', ');
		parts.push(
			`Asset reference(s) wrapped in backticks AND missing the \`assets/\` prefix — ${pairs}. ` +
				`An asset links only when it is written bare with its full \`assets/<path>\` handle; a ` +
				`backticked or prefix-dropped path reads as inert code or a repo file and never links, ` +
				`even after the asset lands. Write each exactly as \`list_project_assets\` returns it, ` +
				`bare and prefixed.`,
		);
	}
	if (hasAgents) {
		parts.push(
			'For a teammate, @<slug> also wakes them on this ticket; use @@<slug> to refer without notifying.',
		);
	}
	return parts.join(' ');
}

/**
 * Returns a warning when an agent posts an active mention (an ask) on a task
 * that is already terminal, or null otherwise. A done/cancelled task reads as
 * finished, so an ask parked on it is easy to miss — the correct move was to
 * ask before closing and keep the task in_progress/review while waiting.
 * Best-effort and non-blocking, exactly like the builders above.
 */
async function buildTerminalTaskAskWarning(
	db: Db,
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
	db: Db,
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
async function markRunProducedOutput(db: Db, runId: string): Promise<void> {
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
async function markRunReportedNoWork(db: Db, runId: string, reason: string): Promise<void> {
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
	content_hash, created_by_member_id, project_id, tags, is_active, auto_load, created_at, updated_at`;

const APPROVAL_COLUMNS = `id, team_id, type, status, requested_by_member_id,
	resolution_note, resolved_at, created_at, payload`;

// Cap MCP tool result payloads at 24 000 bytes — comfortably under the
// Claude Code harness's ~25k-token tool-result limit. Oversized results would
// otherwise be persisted to disk by the harness and become unreadable for the
// agent (the persisted file itself trips the same cap).
export const MCP_RESULT_BYTE_LIMIT = 64_000;

// A few inspection tools return a single, inherently large resource rather than
// a list — a fully-resolved agent system prompt already fills most of the 64 KB
// cap and only grows as shared guidance is added. These get a higher per-tool
// limit so a legitimate single-resource read isn't rejected as
// `result_too_large`; the generic cap still guards every list/query tool against
// context bloat. Keyed by tool name; falls back to MCP_RESULT_BYTE_LIMIT.
export const MCP_RESULT_BYTE_LIMIT_OVERRIDES: Readonly<Record<string, number>> = {
	get_agent_system_prompts: 131_072,
};

// Inline-image cap for read_project_asset. A raster asset at or under this many
// bytes is returned as an actual MCP image content block (base64) so a
// vision-capable runtime can SEE it; a larger image falls back to a signed-URL
// response the agent fetches itself. Kept well under a runtime's tool-result
// ceiling so one image can't dominate the agent's context (~4 MB raw ≈ 5.3 MB
// base64). The generic MCP_RESULT_BYTE_LIMIT guards text/JSON results only — the
// image passthrough bypasses it and is bounded here instead.
export const MCP_INLINE_IMAGE_MAX_BYTES = 4_000_000;

/**
 * True for raster image types (PNG/JPEG/GIF/WebP, …) — `image/*` except SVG,
 * which `isTextAssetMime` classifies as text. These are the types
 * `readImageDimensions` can measure and the runtime can render inline.
 */
function isRasterImageMime(mime: string): boolean {
	return mime.startsWith('image/') && !isTextAssetMime(mime);
}

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

type McpTextContent = { type: 'text'; text: string };
type McpImageContent = { type: 'image'; data: string; mimeType: string };
type McpContentBlock = McpTextContent | McpImageContent;

/**
 * A tool handler normally returns a JSON-serializable value that the wrapper
 * stringifies into one text block. To return richer MCP content — e.g. the
 * actual image for a vision-capable runtime to review — a handler returns this
 * marker instead and the wrapper passes the blocks through untouched (bounded by
 * MCP_INLINE_IMAGE_MAX_BYTES at the call site, not the text-only byte guard).
 */
interface RawToolContent {
	__mcpContent: McpContentBlock[];
}

function isRawToolContent(result: unknown): result is RawToolContent {
	return (
		typeof result === 'object' &&
		result !== null &&
		Array.isArray((result as { __mcpContent?: unknown }).__mcpContent)
	);
}

function tool(
	server: McpServer,
	name: string,
	description: string,
	schema: Record<string, z.ZodType>,
	handler: (args: Record<string, unknown>, db: Db, auth: AuthInfo) => Promise<unknown>,
	db: Db,
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
		// A handler may return pre-shaped MCP content blocks (e.g. an image);
		// pass them through untouched rather than JSON-stringifying.
		if (isRawToolContent(result)) {
			return { content: result.__mcpContent };
		}
		const text = JSON.stringify(result, null, 2);
		const sizeBytes = Buffer.byteLength(text, 'utf8');
		const byteLimit = MCP_RESULT_BYTE_LIMIT_OVERRIDES[name] ?? MCP_RESULT_BYTE_LIMIT;
		if (sizeBytes > byteLimit) {
			const guard = JSON.stringify(
				{
					error: 'result_too_large',
					tool: name,
					size_bytes: sizeBytes,
					limit_bytes: byteLimit,
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
	db: Db,
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
	db: Db,
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
async function authorizeScope(db: Db, auth: AuthInfo, scope: ToolScope): Promise<string | null> {
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
async function authorizeTeam(db: Db, auth: AuthInfo, teamId: string): Promise<string | null> {
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
	db: Db,
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

/**
 * Standard `filter` entry for doc/asset tools that can see archived items.
 * Defaults to 'active' so archived (soft-deleted) items stay invisible unless
 * a call explicitly asks for 'archived' or 'all'.
 */
const archiveFilterArg = () =>
	z
		.enum(Object.values(ArchiveFilter) as [string, ...string[]])
		.optional()
		.describe(
			"Which archive states to consider: 'active' (default — archived items are excluded), 'archived' (only archived), or 'all'.",
		);

const toArchiveFilter = (value: unknown): ArchiveFilter =>
	(value as ArchiveFilter | undefined) ?? ArchiveFilter.Active;

/**
 * Standard `sort` entry for the asset listing. Defaults to 'newest' (the
 * historical `created_at DESC` order).
 */
const assetSortArg = () =>
	z
		.enum(Object.values(AssetSortOrder) as [string, ...string[]])
		.optional()
		.describe(
			"Order of the returned assets: 'newest' (default — most recently created first), 'oldest', or 'alphabetical' (by filename, A→Z).",
		);

const toAssetSortOrder = (value: unknown): AssetSortOrder =>
	(value as AssetSortOrder | undefined) ?? AssetSortOrder.Newest;

export function registerTools(
	server: McpServer,
	db: Db,
	dataDir: string,
	masterKeyManager: MasterKeyManager,
	wsManager?: WebSocketManager,
	events?: DomainEventBus,
	containerDeps?: ContainerDeps,
	assetStore?: AssetStore,
	serverPort?: number,
): ToolDef[] {
	registeredTools.length = 0;
	// Startup always passes the selected store; the fallback covers direct
	// callers (reference generation, tests) that register without running
	// handlers or with a plain local data dir.
	const assets = assetStore ?? new LocalAssetStore(dataDir);
	// Port for agent-facing download URLs (host.docker.internal origin).
	const agentPort = serverPort ?? 0;

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
			assignee_id: z
				.string()
				.optional()
				.describe('Filter by assignee — an agent slug (e.g. "engineer") or a member UUID'),
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
			let assigneeId = args.assignee_id
				? ((await resolveAssigneeId(db, scope.teamId, args.assignee_id as string)) ?? undefined)
				: undefined;
			// An assignee_id that resolves to nobody (unknown slug/id) matches nothing.
			if (args.assignee_id && !assigneeId) return [];
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
		'suggest_goal',
		'Suggest a project goal for the admin to approve. Callable only by the team Captain (or the CEO targeting a team via `project`). Goals come from the admin, so ask first: before suggesting anything, ask the admin what they want the project to achieve (on the planning/onboarding task or via an @admin comment), wait for their reply, and formulate each suggestion from their stated objectives — never file a suggestion the admin\'s own words do not support. This does NOT create a goal directly — it files a suggestion the admin reviews as an Approve/Deny card; the real goal exists only once they approve. A goal is an OUTCOME or MILESTONE the admin wants the project to achieve — a state of the world to reach, or reach and hold (e.g. "reach 10k monthly readers", "100 active customers, held"); its `measurement` judges results, never activity performance. If the candidate reads as "do X every day/week" — monitor, sweep, deliver a periodic report, keep a process running — it is NOT a goal: that is recurring operational work, filed with `create_task` as a standing task that stays open (optionally linked to a goal via `goal_id`), and so is any finite deliverable with a fixed done state — a document to produce, a one-time analysis, a feature to ship. Pass a `title`, a `measurement` (the precise definition of when it is achieved — the bar to judge against; write it SMART), optional `actions` (guidance on what to do/check when assessing it), a `check_frequency` (daily/weekly/monthly — how often the Captain re-assesses progress, not a schedule for doing work), and an optional `target_date` (deadline, ISO YYYY-MM-DD — milestones with target dates are legitimate goals). Pass `task_id` (recommended — usually your planning task) to surface the suggestion as an Approve/Deny card in that task\'s thread; it also appears on the project\'s Goals page.',
		{
			project: projectArg(),
			title: z.string().describe('Short goal title.'),
			measurement: z
				.string()
				.optional()
				.describe('The precise, measurable definition of when the goal is achieved.'),
			actions: z
				.string()
				.optional()
				.describe(
					'Optional guidance on what the Captain should do or check when assessing the goal.',
				),
			check_frequency: z
				.enum(['daily', 'weekly', 'monthly'])
				.optional()
				.describe(
					"How often the goal is re-assessed once created (default daily). This is the Captain's re-assessment cadence, not a schedule for doing work: pick by how often the measurement meaningfully changes — daily for fast-moving measurements, weekly for steady ones, monthly for slow-moving outcomes. Checks recur indefinitely — this is a cadence, not a deadline.",
				),
			target_date: z.string().optional().describe('Optional deadline as an ISO date (YYYY-MM-DD).'),
			task_id: z
				.string()
				.optional()
				.describe(
					'Optional originating task to attach the suggestion card to — a task identifier (e.g. "HM-1") or UUID.',
				),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent || !auth.memberId) {
				return { error: 'suggest_goal is only callable by agents' };
			}
			const caller = await db.query<{ slug: string }>(
				'SELECT slug FROM member_agents WHERE id = $1',
				[auth.memberId],
			);
			const callerSlug = caller.rows[0]?.slug;
			if (callerSlug !== CAPTAIN_AGENT_SLUG && callerSlug !== CEO_AGENT_SLUG) {
				return { error: 'Only the Captain or CEO can suggest goals' };
			}
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const teamId = scope.teamId;

			const proj = await db.query<{ is_internal: boolean }>(
				`SELECT is_internal FROM projects WHERE id = $1 AND team_id = $2`,
				[scope.projectId, teamId],
			);
			if (proj.rows.length === 0) return { error: 'Project not found' };
			if (proj.rows[0].is_internal) return { error: 'The HQ project does not support goals' };

			const title = (args.title as string)?.trim();
			if (!title) return { error: 'title is required' };

			let taskId: string | null = null;
			if (args.task_id !== undefined) {
				const resolved = await resolveTaskId(db, teamId, args.task_id as string);
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

			const payload: GoalSuggestionPayload = {
				project_id: scope.projectId,
				title,
				measurement: args.measurement as string | undefined,
				actions: args.actions as string | undefined,
				check_frequency: args.check_frequency as string | undefined,
				target_date: (args.target_date as string | undefined) ?? null,
				task_id: taskId,
			};
			const row = await insertGoalSuggestionApproval(db, teamId, payload, auth.memberId);
			broadcastApprovalChange(wsManager, teamId, 'INSERT', row);
			if (taskId) {
				await insertGoalSuggestionComment(
					db,
					{
						taskId,
						approvalId: row.id as string,
						payload: payload as unknown as Record<string, unknown>,
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
		"Record your current assessment of a goal's progress. Only the Captain does this, and only from within a progress-update run. Pass progress_percent (0-100, your honest estimate — do not lower it without a reason in the blurb), health (on_track / at_risk / off_track, weighing progress against the target_date), and a one-paragraph status_blurb explaining where the goal stands and what is needed next. This updates the goal's live status and appends a point to its progress history; the goal then won't be re-surfaced for checking until its cadence elapses again. Reaching 100 does not end tracking: the goal stays on its cadence forever (progress can later drop back below 100, and some goals are never-ending, measured continuously), so keep recording your honest current assessment on every check.",
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
		`Create multiple tasks in one call (max ${MAX_BATCH_CREATE_TASKS}). Items are created in order; each has the same shape as create_task, and per-item errors are returned without aborting the rest. When the items are slices of the ticket you are on — delegated tracks handed to direct reports, parallel slices, phases of its deliverable — set parent_task_id on EACH item (normally your current ticket) so they are sub-tasks; filing them top-level detaches them and lets the parent close while they are still open. Within a batch, blocked_by_task_ids entries may reference an earlier item in the same call by zero-based index token — '#0' is the first item. To chain sequential work (e.g. implementation phases that must run one at a time), set blocked_by_task_ids: ['#<previous index>'] on every item after the first; each task then stays blocked until the one before it reaches a terminal status. Filing sequential phases WITHOUT these blockers makes all of them runnable at once. Index tokens may only point at earlier items; a token that is self-referencing, forward-referencing, or points at an item that failed errors that item. Use this when filing a related set of tickets in one go (planning a feature, splitting a ticket into phases or sub-tasks). For a single task, use create_task.`,
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
			assignee_id: z
				.string()
				.optional()
				.describe('New assignee — an agent slug (e.g. "engineer") or a member UUID'),
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

			// Accept a teammate slug (what an agent holds) or a member UUID; every
			// downstream check + the UPDATE below consumes the resolved member id.
			if (typeof args.assignee_id === 'string' && args.assignee_id) {
				const resolvedAssignee = await resolveAssigneeId(db, teamId, args.assignee_id);
				if (!resolvedAssignee) return { error: `Assignee not found: ${args.assignee_id}` };
				args.assignee_id = resolvedAssignee;
			}

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
						dataDir,
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
		marketplace_slug: z
			.string()
			.optional()
			.describe(
				'A marketplace team slug (from get_marketplace_team / the intake baseline) to provision the roster from directly. Mutually exclusive with template_id and source_team_id.',
			),
		intake_task_id: z
			.string()
			.optional()
			.describe(
				'The HQ project-intake ticket this fulfils (its identifier, e.g. "HQ-1", or its UUID); it is closed with a completion note on success.',
			),
	} satisfies z.ZodRawShape;
	tool(
		server,
		'create_project',
		'Create a new project together with its dedicated team. CEO-only. Call this ONLY after the admin has explicitly approved the finalised scope AND team type in the intake conversation — a plain reply approving it is enough (there is no inbox button to wait on), but do not call it while still scoping, on assumed defaults, or in the same turn you propose the plan; creating a project stands up a full team + container, so wait for the go-ahead. Provisions the team from the chosen source (pass template_id from list_team_templates, source_team_id to clone an existing team, or marketplace_slug to provision a marketplace team; defaults to Blank), creates the project, its planning ticket, and the initial CEO coherence/setup ticket the planning ticket is blocked on, then provisions the container. The coherence/setup ticket is created unassigned and does NOT start automatically on this path: first author its description (update_task on the returned coherence_task_identifier) to capture the concrete setup you agreed in intake — the exact roles to hire, any system-prompt rewrites, and the reporting structure — then call start_team_setup(project) to begin the run. When intake_task_id is given, the intake conversation is closed with a completion note. Returns the new project plus its planning and coherence ticket identifiers.',
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
			const rawIntakeTaskId = input.intake_task_id?.trim() || undefined;
			let intakeTaskId: string | undefined;
			let intakeTeamId: string | undefined;
			if (rawIntakeTaskId) {
				// Accept either the intake ticket's identifier (e.g. "HQ-1") or its
				// UUID, like every other task reference on the MCP surface. Intake
				// tickets always live in HQ, so resolve within the default team.
				intakeTaskId = (await resolveTaskId(db, DEFAULT_TEAM_ID, rawIntakeTaskId)) ?? undefined;
				if (!intakeTaskId) return { error: 'Intake task not found' };
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
					marketplaceSlug: input.marketplace_slug,
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
		'List local team templates: the built-in Blank template plus any custom templates saved from existing teams. The default specialist rosters (e.g. the software-development "Startup" team) live in the marketplace, not here. Use when recommending a team structure to hire.',
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
				 -- Built-in templates other than Blank now live in the marketplace and are
				 -- never surfaced here (parallels GET /api/team-templates); a legacy seeded
				 -- "Startup" row on a pre-marketplace instance is filtered out.
				 WHERE NOT (ct.is_builtin AND ct.name <> 'Blank')
				 GROUP BY ct.id
				 ORDER BY ct.is_builtin DESC, ct.name ASC`,
			);
			return r.rows;
		},
		db,
	);

	tool(
		server,
		'get_marketplace_team',
		"Fetch one marketplace team's full definition: its version, changelog, and every role's title, reporting line, and CURRENT system prompt (including the Captain override). CEO-only. Use this when adding/updating a team so you can compare the marketplace's prompts to the agents you already have and decide what to refresh.",
		{
			slug: z.string().describe('The marketplace team slug (e.g. "software-development").'),
		},
		async (args, _db) => {
			const slug = String(args.slug ?? '').trim();
			if (!slug) return { error: '`slug` is required' };
			const teamDef = await getMarketplaceTeam(slug);
			if (!teamDef) return { error: `Marketplace team "${slug}" not found` };
			return {
				slug: teamDef.slug,
				name: teamDef.name,
				version: teamDef.version,
				changelog: teamDef.changelog,
				captain: teamDef.captain,
				roster: teamDef.roster.map((r) => ({
					slug: r.slug,
					title: r.title,
					reports_to_slug: r.reports_to_slug,
					role_description: r.role_description,
					summary: r.summary,
					team_context: r.team_context,
					system_prompt: r.system_prompt,
				})),
			};
		},
		db,
	);

	tool(
		server,
		'apply_marketplace_team',
		"Add or update a marketplace team's roster on a project's team. CEO-only. Fetches the named marketplace team and provisions its members directly onto the project's existing team — a direct add, not an approval-gated hire proposal, so use it only for a team the admin already chose. Roles the team already has are SKIPPED by default; pass refresh_existing=true to instead refresh those roles' descriptions and system prompts to this team's current versions (use this when the project was created from an earlier version of THIS SAME team — it is a version update, not a duplicate add). refresh_existing overwrites prompts, so before using it on roles that may carry local customizations, read them (get_agent_system_prompt) and the new versions (get_marketplace_team) and refresh selectively with update_agent_system_prompt instead. After it returns, reconcile the merged roster. Returns the roles added, refreshed, and skipped.",
		{
			project: projectArg(),
			slug: z.string().describe('The marketplace team slug to add (e.g. "software-development").'),
			refresh_existing: z
				.boolean()
				.optional()
				.describe(
					"When true, refresh roles the team already has to this team's current prompts/descriptions instead of skipping them. Default false. Use for a version update of the same team; prefer selective update_agent_system_prompt when roles carry customizations.",
				),
		},
		async (args, db, auth) => {
			// CEO-only: this is the tool the add-marketplace-team CEO task calls.
			if (auth.type === AuthType.Agent) {
				const caller = await db.query<{ slug: string }>(
					'SELECT slug FROM member_agents WHERE id = $1',
					[auth.memberId],
				);
				if (caller.rows[0]?.slug !== CEO_AGENT_SLUG) {
					return { error: 'Only the CEO can add a marketplace team' };
				}
			}
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const slug = String(args.slug ?? '').trim();
			if (!slug) return { error: '`slug` is required' };
			const teamDef = await getMarketplaceTeam(slug);
			if (!teamDef) return { error: `Marketplace team "${slug}" not found` };

			const result = await applyMarketplaceTeamToTeam(db, scope.teamId, teamDef, {
				wsManager,
				enqueueReconcile: false,
				refreshExisting: args.refresh_existing === true,
			});
			return {
				added: result.created_slugs,
				refreshed: result.updated_slugs ?? [],
				skipped: result.skipped_slugs,
				captain_updated: result.builtin_updated_slugs.length > 0,
				version: teamDef.version,
			};
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
				.describe(
					'A comment id (UUID) or public_id — return only comments created before that one',
				),
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
					`(ic.created_at, ic.id) < (SELECT created_at, id FROM task_comments WHERE (id::text = $${params.length} OR public_id = $${params.length}) AND task_id = $1 LIMIT 1)`,
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
			const viewerMemberId = await resolveReactorMemberId(db, auth, teamId);
			const reactionsByComment = await loadReactionsForTask(db, taskId, viewerMemberId);
			const commentIds = r.rows.map((row) => row.id as string);
			const attachmentsByComment = await loadAgentAttachmentsForComments(
				db,
				commentIds,
				masterKeyManager,
				agentPort,
			);
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

	tool(
		server,
		'list_task_runs',
		"List the agent runs (container executions) recorded for a task, newest first (up to 50). Each row is one run: which agent ran, its status and exit code, when it started/finished, the invocation command, and the log length. Metadata only — fetch a run's actual container log with get_run_log(run_id). Useful for reviewing HOW a task was worked (e.g. the Coach checking what an agent actually did, beyond the comments it left).",
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID'),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			const r = await db.query<Record<string, unknown>>(
				`SELECT hr.id, hr.status, hr.exit_code, hr.started_at, hr.finished_at,
				        hr.invocation_command, length(hr.log_text) AS log_length,
				        ma.title AS agent_title, ma.slug AS agent_slug
				 FROM heartbeat_runs hr
				 LEFT JOIN member_agents ma ON ma.id = hr.member_id
				 WHERE hr.task_id = $1 AND hr.team_id = $2
				 ORDER BY hr.started_at DESC
				 LIMIT 50`,
				[taskId, teamId],
			);
			return r.rows;
		},
		db,
	);

	tool(
		server,
		'get_run_log',
		"Fetch the container log for a single agent run (a run_id from list_task_runs). Returns the run's log capped to the most recent excerpt_chars characters (default 12000 — the tail, where the outcome and any errors are) with truncated/length flags so you can tell when earlier output was dropped. Team-scoped: the run must belong to the project you're acting in.",
		{
			project: projectArg(),
			run_id: z.string().describe('Run ID (UUID) from list_task_runs'),
			excerpt_chars: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Max characters to return from the END of the log (default 12000).'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const runId = args.run_id as string;
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
				return { error: `Invalid run_id: ${runId}` };
			}
			const r = await db.query<{
				id: string;
				status: string;
				exit_code: number | null;
				task_id: string | null;
				log_text: string;
			}>(
				`SELECT id, status, exit_code, task_id, log_text
				 FROM heartbeat_runs WHERE id = $1 AND team_id = $2`,
				[runId, scope.teamId],
			);
			if (r.rows.length === 0) return { error: `Run not found in this project: ${runId}` };
			const run = r.rows[0];
			const full = run.log_text ?? '';
			const max = (args.excerpt_chars as number | undefined) ?? 12_000;
			const truncated = full.length > max;
			return {
				id: run.id,
				status: run.status,
				exit_code: run.exit_code,
				task_id: run.task_id,
				log: truncated ? full.slice(full.length - max) : full,
				length: full.length,
				truncated,
			};
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
			const memberId = await resolveReactorMemberId(db, auth, teamId);
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
			const memberId = await resolveReactorMemberId(db, auth, teamId);
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
					'The comment you are replying to — its id (UUID) or its public_id. Setting this wakes that comment\'s author with source=reply and renders this comment as "replying to ..." in the UI.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			let parentCommentId: string | null = null;
			if (args.parent_comment_id) {
				// Accept the parent's id (UUID) or its public_id; store the resolved
				// UUID as the reply FK. `id::text = $1` avoids the uuid-cast error a
				// raw `id = $1` throws when a public_id is passed.
				const parentCheck = await db.query<{ id: string }>(
					'SELECT id FROM task_comments WHERE (id::text = $1 OR public_id = $1) AND task_id = $2 LIMIT 1',
					[args.parent_comment_id, taskId],
				);
				if (parentCheck.rows.length === 0) {
					return { error: 'parent_comment_id does not belong to this task' };
				}
				parentCommentId = parentCheck.rows[0].id;
			}
			const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const authorApiKeyId = apiKeyIdFromAuth(auth);
			// Attribute the comment to the run that wrote it (only on the agent-run path) so the
			// goal detail page can show "this progress-update run commented on task X".
			const createdByRunId = auth.type === AuthType.Agent ? (auth.runId ?? null) : null;
			// Insert + realtime broadcast + mention/@admin/reply wakeups, shared with
			// the runner's handoff-delivery guardrail via postAgentComment so a
			// comment the agent posts and one auto-delivered from a stranded final
			// message are byte-identical. RETURNING * includes public_id (the
			// comment-link slug), so the agent gets it back without a list_comments.
			const row = await postAgentComment({
				db,
				wsManager,
				teamId,
				projectId: scope.projectId,
				taskId,
				authorMemberId,
				authorApiKeyId,
				authorUserId: auth.type === AuthType.Admin ? auth.userId : null,
				createdByRunId,
				parentCommentId,
				text: args.content as string,
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
				const [teammateWarning, passiveWarning, backtickWarning, terminalAskWarning] =
					await Promise.all([
						buildUnlinkedMentionWarning(db, teamId, authorMemberId, commentText).catch((e) => {
							log.error('Failed to check comment for unlinked teammate references:', e);
							return null;
						}),
						buildPassiveMentionWarning(db, teamId, authorMemberId, commentText).catch((e) => {
							log.error('Failed to check comment for passive teammate asks:', e);
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
				const warning = [teammateWarning, passiveWarning, backtickWarning, terminalAskWarning]
					.filter((w): w is string => Boolean(w))
					.join(' ');
				if (warning) return { ...row, warning };
			}
			return row;
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
			const [teammateWarning, passiveWarning, backtickWarning] = await Promise.all([
				buildUnlinkedMentionWarning(db, teamId, auth.memberId, args.content as string).catch(
					(e) => {
						log.error('Failed to check edited comment for unlinked teammate references:', e);
						return null;
					},
				),
				buildPassiveMentionWarning(db, teamId, auth.memberId, args.content as string).catch((e) => {
					log.error('Failed to check edited comment for passive teammate asks:', e);
					return null;
				}),
				buildBacktickedEntityWarning(db, teamId, scope.projectId, args.content as string).catch(
					(e) => {
						log.error('Failed to check edited comment for backticked entity references:', e);
						return null;
					},
				),
			]);
			const warning = [teammateWarning, passiveWarning, backtickWarning]
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
		'Register a third-party connector for the team and ask the human to authenticate. Posts a connect_required comment on the task with a Connect button; the human completes it inline (in the task comment or on the Connectors page). The agent never sees the token; subsequent runs receive the connector via the egress proxy + placeholder substitution. Idempotent: re-registering an already-active connector returns its current state and fires the wakeup immediately.\n\nTwo kinds:\n- kind "saas" (default): a hosted MCP server. Give mcp_url. Auth is chosen by what the provider supports: servers that advertise OAuth Dynamic Client Registration (most MCP servers) authorize with zero config; providers whose Authorization Server cannot do DCR (e.g. GitHub) require a pre-registered client_id and the device flow — register those with provider_id set to a known registry key (e.g. "github").\n- kind "api": a credentialed REST API the agent calls directly (no MCP server). Give base_url + allowed_hosts (+ optional auth placement). For an OAuth-backed API, also set oauth_provider_id to a bundled OAuth-broker provider (e.g. "google-youtube"): the human then completes the OAuth device flow by pasting just a client id, with the provider pre-selected and locked. For a plain static-key API, omit oauth_provider_id and the human attaches an API key.',
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
			kind: z
				.enum(['saas', 'api'])
				.optional()
				.describe(
					"Connector kind. 'saas' (default) = a hosted MCP server (needs mcp_url). 'api' = a credentialed REST API the agent calls directly with no MCP server (needs base_url + allowed_hosts) — use this for an OAuth-backed HTTP API like a Google API.",
				),
			mcp_url: z
				.string()
				.optional()
				.describe(
					"URL of the MCP server (HTTP / SSE) — required for kind 'saas'. The OAuth dance is discovered by probing this URL for a 401 + WWW-Authenticate header.",
				),
			mcp_transport: z
				.enum(['http', 'sse'])
				.optional()
				.describe('Transport for the MCP server. Defaults to http.'),
			provider_id: z
				.string()
				.optional()
				.describe(
					'Optional MCP capability-registry key (e.g. "datocms", "github"). When set, capability defaults from the shared registry pre-fill display name and allowed hosts. This is the MCP-server registry namespace — not the OAuth-broker provider (see oauth_provider_id).',
				),
			base_url: z
				.string()
				.optional()
				.describe(
					"For kind 'api' — the REST API base URL agents call (e.g. https://www.googleapis.com/youtube/v3).",
				),
			allowed_hosts: z
				.array(z.string())
				.optional()
				.describe(
					'For kind \'api\' — the hosts the credential may be sent to (e.g. ["*.googleapis.com"]). Required for api connectors.',
				),
			auth: z
				.object({
					placement: z.enum(['header', 'query']),
					name: z.string(),
					scheme: z.string().optional(),
				})
				.optional()
				.describe(
					"For kind 'api' — where the credential rides. Defaults to an `Authorization: Bearer ` header when omitted (the right default for OAuth access tokens).",
				),
			oauth_provider_id: z
				.string()
				.optional()
				.describe(
					'For kind \'api\' only — a bundled OAuth-broker provider key (e.g. "google-youtube") to pre-select for the human. The provider is then LOCKED in the completion UI: the human finishes the OAuth device flow inline (in the task comment or on the Connectors page) by pasting only a client id — no provider picker. Omit for a plain API-key REST connector.',
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
			const kind = (args.kind as 'saas' | 'api' | undefined) ?? 'saas';
			const mcpTransport = (args.mcp_transport as 'http' | 'sse' | undefined) ?? 'http';
			const skillId = (args.skill_id as string | undefined) ?? null;

			// For an OAuth REST-API connector, validate the api config and the
			// bundled broker provider (if any) up front. The provider is persisted
			// on the connector so the completion UI can lock it and the device-flow
			// start resolves it without the client re-sending it.
			let apiConfig: Record<string, unknown> | undefined;
			if (kind === 'api') {
				const oauthProviderId = (args.oauth_provider_id as string | undefined)?.trim();
				if (oauthProviderId) {
					const known = resolveConnectorRegistry().oauthProviders.some(
						(p) => p.id === oauthProviderId,
					);
					if (!known) return { error: `unknown oauth_provider_id=${oauthProviderId}` };
				}
				const validated = validateApiConnectorConfig({
					base_url: args.base_url,
					allowed_hosts: args.allowed_hosts,
					// Default to an Authorization: Bearer header — the right carrier for
					// an OAuth access token when the caller doesn't specify.
					auth: (args.auth as Record<string, unknown> | undefined) ?? {
						placement: 'header',
						name: 'Authorization',
						scheme: 'Bearer ',
					},
				});
				if (!validated.ok) return { error: validated.error };
				// Merge the provider preset AFTER validation (the validator strips
				// unknown keys, so oauth_provider_id must not pass through it).
				apiConfig = {
					...(validated.config as unknown as Record<string, unknown>),
					...(oauthProviderId ? { oauth_provider_id: oauthProviderId } : {}),
				};
			} else if (!(args.mcp_url as string | undefined)?.trim()) {
				return { error: "kind 'saas' requires mcp_url" };
			}
			const mcpUrl = kind === 'saas' ? (args.mcp_url as string).trim() : undefined;

			// Slug from providerId if available, else from display_name. Connectors
			// are scoped by project, so `(project_id, name)` is the idempotency key.
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
				kind: kind === 'api' ? ConnectorTransport.Api : undefined,
				apiConfig,
				skillId,
				createdByTaskId: taskId,
				projectId: scope.projectId,
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
		"Fetch a remote agent skill file (Markdown describing how to use a third-party MCP server) and store it as a skill (auto_load). Returns the skill_id and slug. Subsequent agent runs get this skill file injected into their adapter's skills directory. Idempotent on the derived slug — re-fetching the same URL updates the existing skill. Choose `scope`: 'global' shares it with every project (e.g. a widely-used MCP's usage docs), 'project' keeps it private to this project. Defaults to 'project'.",
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
			scope: z
				.enum(['project', 'global'])
				.optional()
				.describe(
					"'global' shares the skill with every project; 'project' keeps it private to this project. Defaults to 'project'.",
				),
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
			const targetProjectId = args.scope === 'global' ? null : scope.projectId;
			const { createHash } = await import('node:crypto');
			const contentHash = createHash('sha256').update(body).digest('hex');
			const description = deriveSkillSummary(body);

			const existing = await db.query<{ id: string }>(
				'SELECT id FROM skills WHERE slug = $1 AND project_id IS NOT DISTINCT FROM $2',
				[slug, targetProjectId],
			);
			// Flagged auto_load so the runner writes it to ~/.claude/skills for every
			// (scoped) run. Idempotent on slug within the chosen scope.
			const conflictTarget = targetProjectId
				? '(project_id, slug) WHERE project_id IS NOT NULL'
				: '(slug) WHERE project_id IS NULL';
			const upserted = await db.query<{ id: string; slug: string }>(
				`INSERT INTO skills (name, slug, description, content, source_url, content_hash, created_by_member_id, tags, auto_load, project_id)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, true, $8)
				 ON CONFLICT ${conflictTarget} DO UPDATE SET
				   name = EXCLUDED.name,
				   description = EXCLUDED.description,
				   content = EXCLUDED.content,
				   source_url = EXCLUDED.source_url,
				   content_hash = EXCLUDED.content_hash,
				   auto_load = true,
				   updated_at = now()
				 RETURNING id, slug`,
				[title, slug, description, body, url, contentHash, authorMemberId, targetProjectId],
			);

			return {
				skill_id: upserted.rows[0].id,
				slug: upserted.rows[0].slug,
				scope: targetProjectId ? 'project' : 'global',
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
		`Read multiple agent system prompts in one call (max ${MAX_BATCH_AGENT_SYSTEM_PROMPTS}). Per-item \`mode\` chooses the resolution depth: \`placeholders\` (default) substitutes \`{{…}}\` with real values and stops, matching get_agent_system_prompt's default; \`preview\` additionally appends the resolver's runtime blocks (Project State, Team Context, Teammates, Working Guidelines) minus the per-run Run Context, matching the web UI's preview panel; \`raw\` returns the stored template untouched. Use this to compare prompts across the team in one round-trip — e.g. Captain auditing how team_context renders for every agent. SIZE: this tool has a raised 128KB result cap (a fully-resolved \`preview\` prompt is large), but still batch multiple items only as \`raw\`/\`placeholders\` and fetch previews one at a time so a multi-\`preview\` call can't exceed even the raised cap (result_too_large). For a single prompt, use get_agent_system_prompt.`,
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
		'Apply a system prompt change for an agent. Callable by the Coach agent (for after-task learned-rules updates), the CEO (during cross-project coherence, from anywhere including its live chat), or the Captain of the same team (during team-coherence reviews). The change is applied immediately and a revision snapshot is stored so the admin can restore previous versions.',
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

			const allowed =
				(await isHqInstanceAgent(db, auth)) || (await canCoordinateTeam(db, auth, teamId));
			if (!allowed) {
				return {
					error: 'Access denied: only the CEO, Coach, or Captain can update system prompts',
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
				enqueueTeamCoherenceReviewTask(db, teamId, 'prompt_updated', {
					changeSummary: `Updated ${targetSlug}'s system prompt: ${args.change_summary as string}`,
				}).catch((e) =>
					log.error('Failed to enqueue team coherence review after prompt update:', e),
				),
			);

			return { applied: true, document_id: doc.id };
		},
		db,
	);

	tool(
		server,
		'update_agent_system_prompts',
		`Apply system prompt changes to MULTIPLE agents in one call — the preferred way when a review touches several agents at once (e.g. the Coach applying learned rules across everyone in a feedback loop). Same callers and rules as update_agent_system_prompt (the CEO, the Coach, or the team's Captain); each change is applied immediately with its own revision snapshot. Files a SINGLE team-coherence review that summarises all the updates, so the Captain/CEO can account for them together. Prefer this over calling update_agent_system_prompt in a loop. Up to ${MAX_BATCH_AGENT_SYSTEM_PROMPTS} at once.`,
		{
			project: projectArg(),
			updates: z
				.array(
					z.object({
						agent_id: z.string().describe('Target agent — its slug (e.g. "engineer") or member ID'),
						new_system_prompt: z
							.string()
							.describe(
								`Full updated prompt for this agent; MUST keep every required substitution variable (${REQUIRED_SYSTEM_PROMPT_VARS.join(', ')}) unless the target is the CEO/Coach.`,
							),
						change_summary: z.string().describe('Summary of what changed and why for this agent'),
					}),
				)
				.min(1)
				.max(MAX_BATCH_AGENT_SYSTEM_PROMPTS)
				.describe(`Up to ${MAX_BATCH_AGENT_SYSTEM_PROMPTS} prompt updates.`),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			const allowed =
				(await isHqInstanceAgent(db, auth)) || (await canCoordinateTeam(db, auth, teamId));
			if (!allowed) {
				return {
					error: 'Access denied: only the CEO, Coach, or Captain can update system prompts',
				};
			}

			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const updates = args.updates as Array<{
				agent_id: string;
				new_system_prompt: string;
				change_summary: string;
			}>;

			const results: Array<Record<string, unknown>> = [];
			const applied: Array<{ slug: string; change_summary: string }> = [];
			for (let i = 0; i < updates.length; i++) {
				const u = updates[i];
				const agentId = await resolveAgentId(db, teamId, u.agent_id);
				const agentCheck = agentId
					? await db.query<{ id: string; slug: string }>(
							`SELECT ma.id, ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id
							 WHERE ma.id = $1 AND m.team_id = $2`,
							[agentId, teamId],
						)
					: null;
				if (!agentId || !agentCheck || agentCheck.rows.length === 0) {
					results.push({
						index: i,
						agent_id: u.agent_id,
						ok: false,
						error: 'Agent not found in this team',
					});
					continue;
				}
				const slug = agentCheck.rows[0].slug;
				const isInstanceSingleton = (INSTANCE_AGENT_SLUGS as readonly string[]).includes(slug);
				if (!isInstanceSingleton) {
					const promptError = requiredSystemPromptVarsError(u.new_system_prompt);
					if (promptError) {
						results.push({ index: i, agent_id: u.agent_id, ok: false, error: promptError });
						continue;
					}
				}
				const doc = await upsertDocument(db, undefined, {
					scope: { type: DocumentType.AgentSystemPrompt, teamId, memberAgentId: agentId },
					content: u.new_system_prompt,
					changeSummary: u.change_summary,
					authorMemberId: callerMemberId,
				});
				results.push({ index: i, agent_id: u.agent_id, slug, ok: true, document_id: doc.id });
				applied.push({ slug, change_summary: u.change_summary });
			}

			if (applied.length > 0) {
				const summary = `Updated ${applied.length} agent prompt(s): ${applied
					.map((a) => `${a.slug} (${a.change_summary})`)
					.join('; ')}`;
				trackBackground(
					enqueueTeamCoherenceReviewTask(db, teamId, 'prompt_updated', {
						changeSummary: summary,
					}).catch((e) =>
						log.error('Failed to enqueue team coherence review after batch prompt update:', e),
					),
				);
			}

			return { results, applied_count: applied.length };
		},
		db,
	);

	tool(
		server,
		'get_project_custom_prompt',
		'Read this project\'s Custom Prompt — the project-wide instruction block (the project context / "preferences") that is injected verbatim into every agent\'s system prompt in this project. Returns the current content plus its length and last-updated time (empty content when none is set yet). Read this before update_project_custom_prompt so you extend the existing guidance rather than overwrite it.',
		{
			project: projectArg(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const doc = await getDocument(db, {
				type: DocumentType.TeamPreferences,
				teamId: scope.teamId,
			});
			const content = doc?.content ?? '';
			return { content, length: content.length, updated_at: doc?.updated_at ?? null };
		},
		db,
	);

	tool(
		server,
		'update_project_custom_prompt',
		"Replace this project's Custom Prompt — the project-wide instruction block (the project context / \"preferences\") injected verbatim into every agent's system prompt in this project. Reach for this when guidance should apply to ALL of the project's agents from the very start of every run (a shared convention, standard, or fact) — it saves editing each agent's prompt one by one. The content you pass REPLACES the whole value, so call get_project_custom_prompt first and extend it. Applied immediately; a revision snapshot is stored so the admin can restore previous versions. Only callable by the CEO, Coach, or the project's Captain.",
		{
			project: projectArg(),
			content: z
				.string()
				.describe(
					'The full new Custom Prompt content (Markdown). Replaces the current value entirely — include the existing guidance you want to keep.',
				),
			change_summary: z
				.string()
				.optional()
				.describe('Short summary of what changed and why (stored on the revision).'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			const allowed =
				(await canCoordinateTeam(db, auth, teamId)) || (await isHqInstanceAgent(db, auth));
			if (!allowed) {
				return {
					error:
						'Access denied: only the CEO, Coach, or Captain can update the project Custom Prompt',
				};
			}

			const prior = await getDocument(db, { type: DocumentType.TeamPreferences, teamId });
			const authorMemberId = await resolveActorMemberId(db, auth, teamId);
			const doc = await upsertDocument(db, wsManager, {
				scope: { type: DocumentType.TeamPreferences, teamId },
				content: args.content as string,
				changeSummary: args.change_summary as string | undefined,
				authorMemberId,
			});

			// The Custom Prompt reaches every agent's prompt, so a real change warrants
			// a team coherence review (same as an agent-prompt edit).
			if ((prior?.content ?? '') !== (args.content as string)) {
				const summary = args.change_summary
					? `Project Custom Prompt updated: ${args.change_summary as string}`
					: 'The project Custom Prompt was updated.';
				trackBackground(
					enqueueTeamCoherenceReviewTask(db, teamId, 'custom_prompt_updated', {
						changeSummary: summary,
					}).catch((e) =>
						log.error('Failed to enqueue coherence review after Custom Prompt update:', e),
					),
				);
			}

			return { applied: true, document_id: doc.id, length: (args.content as string).length };
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
		"List project documentation files (PRD, spec, implementation plan, etc.). Each entry carries its `filename` and a one-line `description` (what the doc is / when to read it, '' if unset). Archived (soft-deleted) docs are excluded by default — set filter: 'archived' or 'all' to see them (entries then carry an `archived` flag).",
		{
			project: projectArg(),
			filter: archiveFilterArg(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const filter = toArchiveFilter(args.filter);
			const docs = await listDocuments(db, {
				type: DocumentType.ProjectDoc,
				teamId: scope.teamId,
				projectId: scope.projectId,
				includeArchived: filter !== ArchiveFilter.Active,
			});
			return {
				files: docs
					.filter((d) => matchesArchiveFilter(d.archived_at, filter))
					.map((d) => ({
						id: d.id,
						filename: d.slug,
						description: d.description,
						updated_at: d.updated_at,
						...(filter !== ArchiveFilter.Active ? { archived: d.archived_at !== null } : {}),
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
		"List the project's assets — files in the assets library (UI mockups, wireframes, diagrams, images, PDFs, scripts, and generated markdown such as blog posts or reports). Filenames may carry a folder prefix up to 2 levels deep (e.g. `launch/images/hero.png`); reference one in a comment or doc as `assets/<path>` exactly as returned here (e.g. assets/launch/images/hero.png), no backticks. Author both text and binary assets with write_project_asset (binary via encoding: 'base64') and reorganize with move_project_asset / copy_project_asset; obsolete assets are archived with archive_project_asset (hard deletion is admin-only). Archived assets are excluded by default — set filter: 'archived' or 'all' to see them (entries then carry an `archived` flag). Raster image entries (PNG/JPEG/GIF/WebP) also carry their pixel `width`/`height`. Results are ordered newest-first by default; pass sort: 'oldest' or 'alphabetical' to change the order.",
		{
			project: projectArg(),
			filter: archiveFilterArg(),
			sort: assetSortArg(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const filter = toArchiveFilter(args.filter);
			const sort = toAssetSortOrder(args.sort);
			const where =
				filter === ArchiveFilter.Active
					? ' AND archived_at IS NULL'
					: filter === ArchiveFilter.Archived
						? ' AND archived_at IS NOT NULL'
						: '';
			const assets = await db.query<{
				id: string;
				original_filename: string;
				content_type: string;
				created_at: string;
				width: number | null;
				height: number | null;
				archived_at: string | null;
			}>(
				`SELECT id, original_filename, content_type, created_at, width, height, archived_at
				 FROM assets WHERE project_id = $1${where}
				 ORDER BY ${assetSortOrderBy(sort)}`,
				[scope.projectId],
			);
			return {
				files: assets.rows.map((a) => ({
					id: a.id,
					filename: a.original_filename,
					content_type: a.content_type,
					created_at: a.created_at,
					...(a.width !== null && a.height !== null ? { width: a.width, height: a.height } : {}),
					...(filter !== ArchiveFilter.Active ? { archived: a.archived_at !== null } : {}),
				})),
			};
		},
		db,
	);

	tool(
		server,
		'write_project_asset',
		'Save a file to the project assets library so a human can open it AND other agents (your teammates and your own future runs) can read it back with read_project_asset — including a binary deliverable or generation output you produced (a rendered image, chart, diagram, screenshot, PDF, dataset, or media file). This is how such a file reaches both the admin and the next agent: a file left on the ephemeral container disk vanishes when the run ends and is invisible to everyone else, so anything a later step or teammate will reuse belongs here. Text formats (.html, .svg, .txt, .md, plus script/text formats stored as plain text: .sh, .py, .js, .ts, .json, .csv, .yaml, .yml) are written with the default encoding "utf8". Binary formats — any type a human can upload (.png, .jpg, .jpeg, .gif, .webp, .pdf, .mp3, .mp4, .webm, …) — MUST pass encoding: "base64" with the file\'s bytes base64-encoded in `content`. For a LARGE binary, upload it instead via a multipart/form-data POST to `/mcp/assets` (fields `file` and `path` for the full destination path, plus optional `overwrite=true` to replace an existing asset in place, same Bearer auth): base64 in a JSON-RPC tool call can be silently truncated by a runtime\'s argument-size cap, whereas the multipart endpoint streams the bytes; the result is identical and shows up in list_project_assets / read_project_asset. When you DO write a binary through this tool, pass `byte_size` (the file\'s exact byte length) so a truncated `content` is rejected instead of stored corrupt. The filename may include a folder path up to 2 levels deep (e.g. "scripts/deploy-check.sh" or "launch/images/hero.png") — folders spring into existence with their first asset. Re-saving the same path overwrites it, so the reference stays stable; overwrite matching is PATH-EXACT ("x.html" and "blog/x.html" are different assets — after a move, write to the new full path or you will fork the file). IMPORTANT: any write to an existing path deletes ALL of its pending review comments (the admin\'s feedback returned by read_project_asset) — capture every comment in your context before the first write, and make all desired edits in one consolidated write. Returns the reference string to drop into a comment as `assets/<path>` (no backticks). HTML opens interactively in a new tab; markdown renders with a rich preview and a view-source toggle; images render inline in the assets library. Use a markdown asset for a standalone deliverable opened from the assets library; use write_project_doc for project context docs (specs, PRDs, research). Mockups and other deliverables belong here, never committed to the source repo.',
		{
			project: projectArg(),
			filename: z
				.string()
				.describe(
					'Path to write, optionally foldered (e.g. "ui-mockups.html", "launch/images/hero.png")',
				),
			content: z
				.string()
				.describe('File content — raw text for utf8, or base64-encoded bytes for base64'),
			encoding: z
				.enum(['utf8', 'base64'])
				.optional()
				.describe(
					'utf8 (default) for text assets; base64 for binary assets (images, PDFs, media) — required for any non-text type',
				),
			byte_size: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"For a base64 binary: the file's exact byte length. When provided, the decoded content is checked against it and a truncated upload (a runtime capping the tool-call argument size, cutting `content` mid-stream) is rejected instead of silently stored. Strongly recommended for binaries.",
				),
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
			if (!contentType || !isAllowedAttachmentMime(contentType)) {
				return {
					error:
						'Unsupported asset type. Allowed: text formats (.html, .svg, .txt, .md, and .sh/.py/.js/.ts/.json/.csv/.yaml/.yml stored as plain text) written with encoding "utf8"; and binary formats (.png, .jpg, .jpeg, .gif, .webp, .pdf, .mp3, .mp4, .webm, …) written with encoding "base64".',
				};
			}

			const content = args.content as string;
			const encoding = (args.encoding as 'utf8' | 'base64' | undefined) ?? 'utf8';
			const isText = isTextAssetMime(contentType);
			if (!isText && encoding !== 'base64') {
				return {
					error: `Binary asset '${filename}' (${contentType}) must be written with encoding: "base64" — base64-encode the file's bytes in \`content\`. Only text formats accept the default utf8 encoding.`,
				};
			}
			let blob: Blob;
			if (encoding === 'base64') {
				// Buffer.from is lenient (it silently drops invalid chars), so validate
				// first and surface a clear error rather than storing corrupt bytes.
				const compact = content.replace(/\s+/g, '');
				if (compact.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
					return {
						error:
							'`content` is not valid base64. Base64-encode the file bytes (standard alphabet, optional `=` padding) and pass them as `content` with encoding: "base64".',
					};
				}
				// Truncation guard. Some coding-CLI runtimes silently cap tool-call
				// argument size, cutting a large base64 `content` mid-stream — which
				// would decode to a truncated, corrupt file while the tool still reports
				// success (the exact failure that produced 15 KB from a 1.16 MB PNG). A
				// valid base64 string's length is never ≡1 (mod 4), and a padded (`=`)
				// string is always a whole number of 4-char groups; either misalignment
				// means the content arrived truncated. Reject loudly and point at the
				// streaming multipart endpoint, which has no JSON-RPC argument limit.
				if (compact.length % 4 === 1 || (compact.includes('=') && compact.length % 4 !== 0)) {
					return {
						error:
							'`content` appears truncated — its base64 length is invalid, which usually means the runtime capped the tool-call argument size. Upload binaries via a multipart/form-data POST to `/mcp/assets` (field `file`, same Bearer auth); it streams the bytes and is not subject to the JSON-RPC argument limit, unlike base64 in write_project_asset.',
					};
				}
				blob = new Blob([new Uint8Array(Buffer.from(compact, 'base64'))], { type: contentType });
				// Deterministic truncation check: when the caller declares the file's
				// byte length, a decode that comes up short means the base64 argument
				// was cut before it reached us (the %4 heuristic above misses cuts that
				// land on a 4-char boundary). Reject rather than store a corrupt file.
				if (args.byte_size !== undefined && blob.size !== (args.byte_size as number)) {
					return {
						error: `\`content\` decoded to ${blob.size} bytes but byte_size=${args.byte_size} was declared — the base64 arrived truncated (a runtime can cap the tool-call argument size, cutting \`content\` mid-stream). Upload binaries via a multipart/form-data POST to \`/mcp/assets\` (fields \`file\`, \`path\`, optional \`overwrite=true\`); it streams the bytes and is not subject to the JSON-RPC argument limit.`,
					};
				}
			} else {
				// Text stays a string BlobPart — Blob encodes it as UTF-8, byte-identical
				// to the prior behaviour.
				blob = new Blob([content], { type: contentType });
			}
			if (blob.size > ATTACHMENT_MAX_BYTES) {
				return { error: 'Asset exceeds 10 MB.' };
			}

			// An archived asset keeps its path reserved; overwriting it would
			// silently resurrect (and clobber) soft-deleted content.
			const archivedHolder = await db.query<{ id: string }>(
				'SELECT id FROM assets WHERE project_id = $1 AND original_filename = $2 AND archived_at IS NOT NULL',
				[projectId, filename],
			);
			if (archivedHolder.rows.length > 0) {
				return {
					error: `Asset 'assets/${filename}' exists but is archived — call unarchive_project_asset first to overwrite it, or write under a different path.`,
				};
			}

			// Capture raster-image pixel dimensions so read_project_asset /
			// list_project_assets can report them without re-parsing the blob.
			const dims = isRasterImageMime(contentType)
				? readImageDimensions(Buffer.from(await blob.arrayBuffer()))
				: null;
			const assetId = crypto.randomUUID();
			const { byteSize, sha256 } = await assets.write(projectId, assetId, blob);
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
					width: dims?.width ?? null,
					height: dims?.height ?? null,
				});
			} catch (e) {
				await assets.delete(projectId, assetId).catch(() => {});
				throw e;
			}
			if (result.replacedAssetId) {
				await assets.delete(projectId, result.replacedAssetId).catch(() => {});
			}
			if (result.wipedReviewComments) {
				// The overwrite consumed the pending review (wiped inside the upsert's
				// transaction) — tell viewers so their comment panes clear live.
				broadcastCommentFamilyChange(
					wsManager,
					teamId,
					projectId,
					'asset_review_comments',
					'DELETE',
					{
						asset_id: result.replacedAssetId,
						cleared: true,
					},
				);
			}
			broadcastRowChange(wsManager, wsRoom.team(teamId), 'assets', 'INSERT', {
				id: result.id,
				team_id: teamId,
				project_id: projectId,
				original_filename: result.original_filename,
			});
			return {
				written: true,
				id: result.id,
				reference: `assets/${result.original_filename}`,
				byte_size: result.byte_size,
				...(dims ? { width: dims.width, height: dims.height } : {}),
			};
		},
		db,
	);

	tool(
		server,
		'read_project_asset',
		"Read a project asset's contents by path (e.g. \"ui-mockups.html\" or \"scripts/check.sh\") — the files that list_project_assets returns (UI mockups, wireframes, SVG diagrams, text exports, scripts, markdown deliverables). Use the full path exactly as listed, folder prefix included. Text-based assets (HTML, SVG, plain text, markdown) come back inline as `content`. Raster images (PNG/JPEG/GIF/WebP) come back with their pixel `width`/`height` AND the image itself inline, so a vision-capable model can see it to review it — pass `include_image: false` to skip the pixels and get metadata only, and images above ~4 MB return metadata + `url` only. Other binary assets (PDFs, media) are not inlined; the response gives a signed download `url` — fetch it with a plain `curl -fsSL '<url>' -o /tmp/<filename>` (no auth header needed; the URL is valid for 24h, re-call this tool for a fresh one). If an admin has left review comments on the asset they come back as `review_comments`: for text assets (markdown, plain text) each anchors to an exact `quote` (with `occurrence` = 0-based Nth match of that snippet); a comment without a quote applies to the whole file. Capture them all before any write_project_asset to the path — overwriting deletes every review comment. Archived assets are not readable by default — set filter: 'archived' or 'all' to read one. For markdown project docs use read_project_doc instead.",
		{
			project: projectArg(),
			filename: z
				.string()
				.describe('Asset path to read (e.g. "ui-mockups.html", "launch/images/hero.png")'),
			filter: archiveFilterArg(),
			include_image: z
				.boolean()
				.optional()
				.describe(
					'For raster images (PNG/JPEG/GIF/WebP): when true (default) the image is returned inline so a vision-capable model can see it. Pass false to get metadata only (dimensions + download URL) and skip the pixels.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const { projectId } = scope;
			const filename = normalizeAssetPath(args.filename as string);
			if (filename === null) return { error: assetPathError(args.filename as string) };

			const found = await db.query<{
				id: string;
				original_filename: string;
				content_type: string;
				byte_size: string;
				width: number | null;
				height: number | null;
				archived_at: string | null;
			}>(
				`SELECT id, original_filename, content_type, byte_size, width, height, archived_at
				 FROM assets WHERE project_id = $1 AND original_filename = $2`,
				[projectId, filename],
			);
			if (found.rows.length === 0) return { error: `Asset '${filename}' not found` };
			const asset = found.rows[0];
			const archived = asset.archived_at !== null;
			const filter = toArchiveFilter(args.filter);
			if (!matchesArchiveFilter(asset.archived_at, filter)) {
				return {
					error: archived
						? `Asset 'assets/${filename}' is archived and the call's filter is 'active' (the default). Set filter: 'archived' or 'all' to read it, or unarchive_project_asset to restore it.`
						: `Asset 'assets/${filename}' is active but the call's filter is '${filter}'. Use filter: 'active' or 'all'.`,
				};
			}

			// A pending admin review rides along on every read (text and binary
			// alike — a whole-asset comment on an image matters as much as a quote
			// anchor in markdown).
			const reviewComments = await listReviewComments(db, { kind: 'asset', assetId: asset.id });
			const reviewField =
				reviewComments.length === 0
					? {}
					: {
							review_comments: reviewComments.map((r) => ({
								id: r.id,
								...(r.quote !== null ? { quote: r.quote, occurrence: r.occurrence } : {}),
								comment: r.comment,
								created_at: r.created_at,
							})),
						};

			// Text-based assets are returned inline; binary assets get a signed
			// download URL the agent fetches itself (curl) — blobs are never on the
			// container filesystem.
			const isText = isTextAssetMime(asset.content_type);
			if (!isText) {
				const raster = isRasterImageMime(asset.content_type);
				const byteSize = Number(asset.byte_size);
				const includeImage = args.include_image !== false;
				let width = asset.width;
				let height = asset.height;
				// A raster asset needs its bytes to backfill missing dimensions
				// and/or to return the image inline for a vision runtime to see.
				const wantInline = raster && includeImage && byteSize <= MCP_INLINE_IMAGE_MAX_BYTES;
				const needBytes = wantInline || (raster && (width === null || height === null));
				let buf: Buffer | null = null;
				if (needBytes) {
					// If the blob can't be read (e.g. a store hiccup or a row with no
					// backing bytes) fall back to the URL-only metadata rather than
					// failing the whole read.
					try {
						buf = await assets.read(projectId, asset.id);
					} catch {
						buf = null;
					}
					if (buf && raster && (width === null || height === null)) {
						const dims = readImageDimensions(buf);
						if (dims) {
							width = dims.width;
							height = dims.height;
							// Self-heal: persist so future reads / list_project_assets
							// don't re-parse this pre-existing asset's blob.
							await db
								.query('UPDATE assets SET width = $1, height = $2 WHERE id = $3', [
									dims.width,
									dims.height,
									asset.id,
								])
								.catch(() => {});
						}
					}
				}
				const metadata = {
					filename: asset.original_filename,
					content_type: asset.content_type,
					byte_size: byteSize,
					binary: true,
					...(width !== null && height !== null ? { width, height } : {}),
					url: await signAgentAssetUrl(asset.id, masterKeyManager, agentPort),
					...(archived ? { archived: true } : {}),
					...reviewField,
				};
				// Under the cap and not opted out: hand the runtime the actual
				// pixels (as an MCP image block) alongside the metadata text.
				if (wantInline && buf) {
					return {
						__mcpContent: [
							{ type: 'text' as const, text: JSON.stringify(metadata, null, 2) },
							{
								type: 'image' as const,
								data: buf.toString('base64'),
								mimeType: asset.content_type,
							},
						],
					};
				}
				return metadata;
			}

			const buf = await assets.read(projectId, asset.id);
			return {
				filename: asset.original_filename,
				content_type: asset.content_type,
				content: buf.toString('utf-8'),
				...(archived ? { archived: true } : {}),
				...reviewField,
			};
		},
		db,
	);

	tool(
		server,
		'move_project_asset',
		'Move or rename a project asset within the assets library: change its folder (up to 2 levels deep), its filename, or both — folders spring into existence when the first asset lands in them and vanish with their last one. The stored file does not change, so the destination must keep the same extension. Moves never overwrite: if the destination path is taken the call fails. IMPORTANT: existing text references to the old `assets/<path>` in comments and docs are NOT rewritten — they degrade to plain text — so update the places that cite the old path, and prefer organizing assets early over moving them later. To retire an obsolete asset, use archive_project_asset instead of moving it aside (hard deletion is admin-only).',
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
			const found = await db.query<{ id: string; archived_at: string | null }>(
				'SELECT id, archived_at FROM assets WHERE project_id = $1 AND original_filename = $2',
				[scope.projectId, from],
			);
			if (found.rows.length === 0) return { error: `Asset 'assets/${from}' not found` };
			if (found.rows[0].archived_at !== null) {
				return {
					error: `Asset 'assets/${from}' is archived — unarchive_project_asset first if you need to move it.`,
				};
			}
			const assetId = found.rows[0].id;
			try {
				await db.query('UPDATE assets SET original_filename = $1 WHERE id = $2', [to, assetId]);
			} catch (e) {
				if (isUniqueViolation(e)) {
					return {
						error: `Destination 'assets/${to}' already exists (it may be an archived asset holding the path) — moves never overwrite. Pick a different name.`,
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
			const found = await db.query<{
				id: string;
				content_type: string;
				archived_at: string | null;
			}>(
				'SELECT id, content_type, archived_at FROM assets WHERE project_id = $1 AND original_filename = $2',
				[scope.projectId, from],
			);
			if (found.rows.length === 0) return { error: `Asset 'assets/${from}' not found` };
			if (found.rows[0].archived_at !== null) {
				return {
					error: `Asset 'assets/${from}' is archived — unarchive_project_asset first if you need to copy it.`,
				};
			}
			const source = found.rows[0];

			const { teamId, projectId } = scope;
			const buf = await assets.read(projectId, source.id);
			const assetId = crypto.randomUUID();
			const { byteSize, sha256 } = await assets.write(
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
				await assets.delete(projectId, assetId).catch(() => {});
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

	// Archival is the agent-facing "delete" for assets: reversible, self-serve,
	// and the archived asset keeps its path reserved so references stay
	// unambiguous. Hard deletion remains a human/admin-only UI action.
	const setAssetArchived = async (
		args: Record<string, unknown>,
		db: Db,
		auth: AuthInfo,
		archived: boolean,
	) => {
		const scope = await resolveScope(db, auth, args);
		if ('error' in scope) return scope;
		const filename = normalizeAssetPath(args.filename as string);
		if (filename === null) return { error: assetPathError(args.filename as string) };
		const found = await db.query<{ id: string; archived_at: string | null }>(
			'SELECT id, archived_at FROM assets WHERE project_id = $1 AND original_filename = $2',
			[scope.projectId, filename],
		);
		if (found.rows.length === 0) return { error: `Asset 'assets/${filename}' not found` };
		const asset = found.rows[0];

		// Idempotent: re-asserting the current state succeeds without stacking
		// events, so a retried run never double-fires.
		if ((asset.archived_at !== null) === archived) {
			return { archived, reference: `assets/${filename}`, changed: false };
		}

		const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
		await db.query(
			`UPDATE assets
			 SET archived_at = CASE WHEN $2 THEN now() ELSE NULL END,
			     archived_by_member_id = CASE WHEN $2 THEN $3::uuid ELSE NULL END
			 WHERE id = $1`,
			[asset.id, archived, archived ? actorMemberId : null],
		);
		events?.emit({
			type: 'asset.archived',
			teamId: scope.teamId,
			projectId: scope.projectId,
			actorType: actorTypeFromAuth(auth),
			actorMemberId,
			actorApiKeyId: apiKeyIdFromAuth(auth),
			assetId: asset.id,
			filename,
			archived,
		});
		broadcastRowChange(wsManager, wsRoom.team(scope.teamId), 'assets', 'UPDATE', {
			id: asset.id,
			team_id: scope.teamId,
			project_id: scope.projectId,
			original_filename: filename,
		});
		return { archived, reference: `assets/${filename}`, changed: true };
	};

	tool(
		server,
		'archive_project_asset',
		'Archive a project asset — the reversible soft delete, and the ONLY way an agent retires an asset (hard deletion is admin-only, so treat any "delete this asset" instruction as archive). The asset disappears from list_project_assets and default reads but keeps its path reserved; existing assets/<path> references in comments and docs keep resolving. Reverse with unarchive_project_asset. No approval needed.',
		{
			project: projectArg(),
			filename: z
				.string()
				.describe(
					'Asset path to archive — the full path exactly as list_project_assets returns it (e.g. "drafts/old-v1.md")',
				),
		},
		async (args, db, auth) => setAssetArchived(args, db, auth, true),
		db,
	);

	tool(
		server,
		'unarchive_project_asset',
		'Restore an archived project asset to active. It reappears in list_project_assets, becomes readable and writable again, and its assets/<path> reference links as before.',
		{
			project: projectArg(),
			filename: z.string().describe('Asset path to restore (the same path it was archived under)'),
		},
		async (args, db, auth) => setAssetArchived(args, db, auth, false),
		db,
	);

	tool(
		server,
		'read_project_doc',
		"Read a markdown project doc by filename (e.g. \"spec.md\") — the high-level project context (PRDs, specs, architecture decisions, research) that list_project_docs returns; the full body comes back inline as `content`. These docs live in the project-doc store in the database, NOT on the filesystem: there is no /workspace/.hezo/project-docs path, so do not reach for the Read/cat file tools — always load a doc through this tool by its bare filename. Archived docs are not readable by default — set filter: 'archived' or 'all' to read one. When the admin has left review feedback on the doc, the result includes `review_comments` — each anchors a `comment` to a `quote` (an exact text snippet; `occurrence` disambiguates repeated snippets). Action them when asked to. IMPORTANT: any write to the doc deletes ALL of its review comments, so capture every comment from this result BEFORE your first write_project_doc call — after one write they are gone. For non-markdown assets (mockups, wireframes, diagrams) use read_project_asset instead.",
		{
			project: projectArg(),
			filename: z.string().describe('Filename to read (e.g. "spec.md")'),
			filter: archiveFilterArg(),
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
			const archived = doc.archived_at !== null;
			const filter = toArchiveFilter(args.filter);
			if (!matchesArchiveFilter(doc.archived_at, filter)) {
				return {
					error: archived
						? `Doc '${doc.slug}' is archived and the call's filter is 'active' (the default). Set filter: 'archived' or 'all' to read it, or unarchive_project_doc to restore it.`
						: `Doc '${doc.slug}' is active but the call's filter is '${filter}'. Use filter: 'active' or 'all'.`,
				};
			}
			const archivedField = archived ? { archived: true } : {};
			const reviewComments = await listReviewComments(db, {
				kind: 'document',
				documentId: doc.id,
			});
			const descriptionField = doc.description ? { description: doc.description } : {};
			if (reviewComments.length === 0)
				return {
					filename: doc.slug,
					...descriptionField,
					content: doc.content,
					...archivedField,
				};
			return {
				filename: doc.slug,
				...descriptionField,
				content: doc.content,
				...archivedField,
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
		"Write a project documentation file. Project docs are markdown only — the filename must end in .md. For high-level project context: PRD, spec, implementation plan, research. Make ALL desired edits in ONE consolidated write per run, for two reasons: (1) writing a doc deletes ALL of its pending review comments (the admin's highlight feedback returned by read_project_doc) — a single write clears the whole review, so capture every comment in your context before the first write; (2) docs are revisioned — every content-changing write records a revision, so many partial writes bury the history in noise. Pass a `changelog` summarizing what changed in this write and why — it becomes that revision's entry in the document's history; keep update/changelog logs OUT of the document body and put them in `changelog` instead. Also pass a one-line `description` of what the doc is and when to read it — it shows next to the filename in the Documents list and the doc header so teammates and future runs can tell what the doc holds at a glance; keep it short and out of the body. Non-markdown files (mockups, wireframes, images, PDFs) live in the project assets library instead — reference those as `assets/<filename>`. In content, reference teammates with @<agent-slug>. Reference tickets and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug — no @ prefix. Do not wrap any of these in backticks — that makes them inert.",
		{
			project: projectArg(),
			filename: z.string().describe('Markdown filename to write (e.g. "spec.md")'),
			content: z.string().describe('File content (markdown)'),
			description: z
				.string()
				.optional()
				.describe(
					'One-line summary of what this doc is and when to read it (e.g. "How we track and report campaign analytics each week"). Shown next to the filename in the Documents list and the doc header, so teammates and future runs can tell what the doc holds without opening it. Keep it to a sentence; it is NOT the changelog and NOT part of the body. Omit to leave any existing description unchanged.',
				),
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
			// An archived doc is read-only; writing would silently resurrect it.
			const prior = await getDocument(db, {
				type: DocumentType.ProjectDoc,
				teamId: scope.teamId,
				projectId: scope.projectId,
				slug: args.filename as string,
			});
			if (prior?.archived_at) {
				return {
					error: `Doc '${args.filename}' is archived — call unarchive_project_doc first, or write under a different filename.`,
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
				description: args.description as string | undefined,
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

	// Archival is the agent-facing "delete" for project docs too: reversible,
	// self-serve, keeps the slug reserved and references resolving. Hard
	// deletion remains a human/admin-only UI action.
	const setDocArchivedTool = async (
		args: Record<string, unknown>,
		db: Db,
		auth: AuthInfo,
		archived: boolean,
	) => {
		const scope = await resolveScope(db, auth, args);
		if ('error' in scope) return scope;
		const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
		const result = await setDocumentArchived(
			db,
			wsManager,
			{
				type: DocumentType.ProjectDoc,
				teamId: scope.teamId,
				projectId: scope.projectId,
				slug: args.filename as string,
			},
			archived,
			callerMemberId,
			{
				events,
				actorType: actorTypeFromAuth(auth),
				actorApiKeyId: apiKeyIdFromAuth(auth),
			},
		);
		if (!result) return { error: `File '${args.filename}' not found` };
		return { archived, filename: result.row.slug, changed: result.changed };
	};

	tool(
		server,
		'archive_project_doc',
		'Archive a project doc — the reversible soft delete, and the ONLY way an agent retires a doc (hard deletion is admin-only, so treat any "delete this doc" instruction as archive). The doc disappears from list_project_docs, default reads, and future runs\' context, but keeps its filename reserved and its revision history; existing references keep resolving. Reverse with unarchive_project_doc. No approval needed.',
		{
			project: projectArg(),
			filename: z.string().describe('Doc filename to archive (e.g. "old-plan.md")'),
		},
		async (args, db, auth) => setDocArchivedTool(args, db, auth, true),
		db,
	);

	tool(
		server,
		'unarchive_project_doc',
		'Restore an archived project doc to active. It reappears in list_project_docs and agent-run context, and becomes readable and writable again with its content and revision history intact.',
		{
			project: projectArg(),
			filename: z.string().describe('Doc filename to restore (e.g. "old-plan.md")'),
		},
		async (args, db, auth) => setDocArchivedTool(args, db, auth, false),
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
		"Propose a new skill for the team's skills database (reusable team know-how: MCP server usage, integration steps, conventions, how agents coordinate). Creates an approval request; when approved the skill is written to the skills database. Choose `scope`: 'global' shares it with every project, 'project' keeps it private to this project. Defaults to 'project'.",
		{
			project: projectArg(),
			skill_name: z.string().describe('Human-readable skill name'),
			skill_slug: z.string().describe('URL-safe slug for the skill file'),
			content: z.string().describe('Skill content (markdown)'),
			reason: z.string().describe('Why this skill should be added'),
			scope: z
				.enum(['project', 'global'])
				.optional()
				.describe(
					"'global' shares the skill with every project; 'project' keeps it private to this project. Defaults to 'project'.",
				),
		},
		async (args, db, auth) => {
			// `connector-recipes` is a reserved built-in virtual skill — reject a
			// proposal that would shadow it.
			if (isConnectorRecipesSlug(args.skill_slug as string)) {
				return {
					error: `'${CONNECTOR_RECIPES_SLUG}' is a reserved built-in skill and cannot be proposed`,
				};
			}
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
						scope: args.scope === 'global' ? 'global' : 'project',
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
		'full_text_search',
		'Full-text keyword search across the team skills database, tasks, project docs, and task comments. Returns results ranked by relevance (keyword + stemming match). A bare task number or full identifier (e.g. "169" or "HM-169") resolves directly to that task, ranked first.',
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

			// This project's own skills plus globals (project shadows a global of
			// the same slug — de-duped below).
			let query = `SELECT id, name, slug, description, tags, project_id, created_at, updated_at
			             FROM skills WHERE is_active = true AND (project_id = $1 OR project_id IS NULL)`;
			const params: unknown[] = [scope.projectId];

			if (args.tags) {
				const tagList = (args.tags as string).split(',').map((t) => t.trim());
				query += ` AND tags ?| $${params.length + 1}`;
				params.push(tagList);
			}

			// Project row before global so the de-dupe keeps the project's shadowing copy.
			query += ' ORDER BY name, project_id NULLS LAST';
			const result = await db.query<{ slug: string }>(query, params);
			const seen = new Set<string>();
			const skills = result.rows.filter((r) => {
				if (seen.has(r.slug)) return false;
				seen.add(r.slug);
				return true;
			});
			return { skills };
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
			// The built-in `connector-recipes` skill is generated from the connector
			// registry, not a DB row — return it directly (no scope needed; it is a
			// global read-only guide).
			if (args.slug === CONNECTOR_RECIPES_SLUG) {
				const s = buildConnectorRecipesSkill();
				return { name: s.name, slug: s.slug, description: s.description, content: s.content };
			}

			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			// Prefer this project's own skill over a global one of the same slug.
			const result = await db.query(
				`SELECT ${SKILL_COLUMNS} FROM skills
				 WHERE slug = $1 AND (project_id = $2 OR project_id IS NULL)
				 ORDER BY project_id NULLS LAST LIMIT 1`,
				[args.slug, scope.projectId],
			);
			if (result.rows.length === 0) return { error: 'Skill not found' };
			return result.rows[0];
		},
		db,
	);

	tool(
		server,
		'create_skill',
		"Add or update a skill in the team's skills database directly (no approval needed) — record reusable team know-how such as MCP server usage, integration steps, conventions, and how agents coordinate. Use propose_skill when approval is required. If description is omitted it is derived from the skill body. Choose `scope` deliberately: 'global' when the know-how helps agents in ANY project (related or not), 'project' when it is specific to this project. Omitting scope defaults to 'project'.",
		{
			project: projectArg(),
			name: z.string().describe('Human-readable skill name'),
			slug: z.string().describe('URL-safe slug'),
			content: z.string().describe('Skill content (markdown)'),
			description: z.string().optional().describe('Short description'),
			tags: z.string().optional().describe('Comma-separated tags'),
			scope: z
				.enum(['project', 'global'])
				.optional()
				.describe(
					"'global' shares the skill with every project; 'project' keeps it private to this project. Defaults to 'project'.",
				),
		},
		async (args, db, auth) => {
			// `connector-recipes` is a reserved built-in virtual skill (generated from
			// the connector registry) — an agent may read it but not shadow it.
			if (isConnectorRecipesSlug(args.slug as string)) {
				return {
					error: `'${CONNECTOR_RECIPES_SLUG}' is a reserved built-in skill and cannot be created or overwritten`,
				};
			}

			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			// The agent chooses the scope; absent a choice we keep it project-private.
			const targetProjectId = args.scope === 'global' ? null : scope.projectId;
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
				'SELECT content FROM skills WHERE slug = $1 AND project_id IS NOT DISTINCT FROM $2',
				[args.slug, targetProjectId],
			);

			// Upsert against the partial unique index matching the chosen scope.
			const conflictTarget = targetProjectId
				? '(project_id, slug) WHERE project_id IS NOT NULL'
				: '(slug) WHERE project_id IS NULL';
			const result = await db.query<{ id: string; slug: string }>(
				`INSERT INTO skills (name, slug, description, content, content_hash, created_by_member_id, tags, project_id)
				 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
				 ON CONFLICT ${conflictTarget} DO UPDATE SET
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
					targetProjectId,
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

			return {
				skill_id: skillId,
				slug: result.rows[0].slug,
				scope: targetProjectId ? 'project' : 'global',
				created: true,
			};
		},
		db,
	);

	tool(
		server,
		'list_connectors',
		'List the connectors available to agent runs in your project (its own connectors plus global "all projects" ones; a project connector shadows a global one of the same name). Each row includes a derived `oauth_status` so you can tell whether a connector is usable: "active" means OAuth completed and the MCP tools should appear in your tool list on your next run; "pending" means waiting on the human to click Connect; "failed" means the OAuth flow errored (see auth_error); "revoked" means a human disconnected it; "none" means no OAuth needed (e.g., an env-var-token MCP or a public one). Do NOT confuse `install_status` (which tracks local-package install state and is meaningless for SaaS MCPs) with `oauth_status`. An active OAuth-backed connector also carries `rest_auth` = `{ placeholder, allowed_hosts, scopes }`: put `placeholder` (e.g. in an `Authorization: Bearer <placeholder>` header) on a raw HTTP request to authenticate the provider\'s REST API directly when no MCP tool covers what you need — the egress proxy substitutes the real token, but ONLY for requests to `allowed_hosts`; you never see the value. Use this instead of requesting a PAT (e.g. for GitHub repo-settings edits that the `github` MCP does not expose). A connector of kind `api` (a credentialed REST API with no MCP server) carries `api_auth` = `{ base_url, placeholder, allowed_hosts, placement, name, docs_url }` instead: put `placeholder` in the `name` header (when `placement` is "header", prefixed by any scheme) or `name` query parameter (when `placement` is "query") and send the request to `base_url` — the egress proxy substitutes the real key, scoped to `allowed_hosts`. `placeholder` is null until a human attaches the credential on the Connectors page; `api_auth` is null for non-api rows. An `api` connector may instead be OAuth-backed (a human connected it via the device flow): then `api_auth.placeholder` is a broker-managed OAuth access token that Hezo keeps refreshed host-side — use it exactly the same way.',
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
				api_key_secret_id: string | null;
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
				oauth_account_label: string | null;
				api_key_secret_name: string | null;
			}>(
				`SELECT mc.id, mc.name, mc.display_name, mc.kind::text AS kind,
				        mc.config, mc.oauth_connection_id, mc.api_key_secret_id,
				        mc.install_status::text AS install_status, mc.install_error,
				        mc.skill_id, mc.created_by_task_id,
				        mc.activated_at::text AS activated_at, mc.revoked_at::text AS revoked_at, mc.auth_error,
				        mc.created_at::text, mc.updated_at::text,
				        s.name AS oauth_secret_name, s.allowed_hosts AS oauth_allowed_hosts, oc.scopes AS oauth_scopes,
				        oc.provider_account_label AS oauth_account_label,
				        aks.name AS api_key_secret_name
				 FROM mcp_connections mc
				 LEFT JOIN oauth_connections oc ON oc.id = mc.oauth_connection_id
				 LEFT JOIN secrets s ON s.id = oc.access_token_secret_id
				 LEFT JOIN secrets aks ON aks.id = mc.api_key_secret_id
				 WHERE mc.project_id = $1 OR mc.project_id IS NULL
				 ORDER BY mc.name ASC, (mc.project_id IS NULL) ASC`,
				[scope.projectId],
			);
			// Derive a single oauth_status field that's the load-bearing signal
			// for whether the connector is usable by agents on subsequent runs.
			const cfg = (row: { config: Record<string, unknown> }): boolean => {
				const c = row.config as { dcr?: unknown };
				return !!c?.dcr;
			};
			// A project connector shadows a global one of the same name (the run sees
			// the same set — see loadConnectorsForRun). Rows are ordered project
			// first, so keep the first occurrence per name.
			const byName = new Map<string, (typeof r.rows)[number]>();
			for (const row of r.rows) if (!byName.has(row.name)) byName.set(row.name, row);
			return [...byName.values()].map((row) => {
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
				const {
					oauth_secret_name,
					oauth_allowed_hosts,
					oauth_scopes,
					api_key_secret_name,
					...rest
				} = row;
				const rest_auth =
					oauth_status === 'active' && oauth_secret_name && (oauth_allowed_hosts?.length ?? 0) > 0
						? {
								placeholder: credentialPlaceholder(oauth_secret_name),
								allowed_hosts: oauth_allowed_hosts ?? [],
								scopes: oauth_scopes ?? [],
							}
						: null;

				// For an `api` connector (a direct REST API, no MCP server), surface how
				// to call it: base_url + auth placement/name, and — once a credential is
				// attached — the `__HEZO_SECRET_*__` placeholder to put in that
				// header/query. The agent hits base_url directly and the egress proxy
				// substitutes the real key, scoped to allowed_hosts. Null placeholder
				// until a key is attached; the whole block is null for non-api rows.
				const apiCfg = row.config as {
					base_url?: unknown;
					allowed_hosts?: unknown;
					auth?: { placement?: unknown; name?: unknown };
					docs_url?: unknown;
				} | null;
				const api_auth =
					row.kind === 'api' && apiCfg
						? {
								base_url: typeof apiCfg.base_url === 'string' ? apiCfg.base_url : null,
								// An api connector may be OAuth-backed (broker-managed): its access
								// token rides the same api_auth placeholder as a pasted key, so
								// surface the OAuth access-token secret name when no pasted key is set.
								placeholder: api_key_secret_name
									? credentialPlaceholder(api_key_secret_name)
									: oauth_secret_name
										? credentialPlaceholder(oauth_secret_name)
										: null,
								allowed_hosts: Array.isArray(apiCfg.allowed_hosts) ? apiCfg.allowed_hosts : [],
								placement:
									apiCfg.auth && typeof apiCfg.auth.placement === 'string'
										? apiCfg.auth.placement
										: null,
								name: apiCfg.auth && typeof apiCfg.auth.name === 'string' ? apiCfg.auth.name : null,
								docs_url: typeof apiCfg.docs_url === 'string' ? apiCfg.docs_url : null,
							}
						: null;
				return { ...rest, oauth_status, rest_auth, api_auth };
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
			connector_id: z.string().describe('connector id or name (both shown by list_connectors)'),
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
				 FROM mcp_connections
				 WHERE (id::text = $1 OR name = $1) AND (project_id = $2 OR project_id IS NULL)
					 ORDER BY (project_id IS NOT NULL) DESC
					 LIMIT 1`,
				[connectorId, scope.projectId],
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
		'add_connector',
		'Register a connector for your project — a SaaS HTTP MCP server (`saas`), a local stdio MCP server (`local`), or a credentialed REST API you call directly with no MCP server (`api`). The connection is scoped to your project — available to this project\'s agent runs, alongside any global "all projects" connectors. SaaS servers go into the agent\'s descriptor list immediately. Header values may include __HEZO_SECRET_<NAME>__ placeholders that the egress proxy substitutes at request time. Local servers must be installed before they take effect. An `api` connector has no MCP server: attach a credential to it (Connectors page → API key) and it surfaces in `list_connectors` as an `api_auth` block whose placeholder you put in the auth header/query and send to `base_url` directly — the egress proxy substitutes, scoped to `allowed_hosts`.',
		{
			project: projectArg(),
			name: z
				.string()
				.trim()
				.min(1, 'name is required')
				.describe('Server identifier — used as the MCP descriptor name and as the unique key.'),
			kind: z
				.enum(['saas', 'local', 'api'])
				.describe('saas = HTTP MCP, local = stdio MCP, api = direct REST API (no MCP server)'),
			config: z
				.record(z.string(), z.unknown())
				.describe(
					'For saas: { url, headers? }. For local: { command, args?, env?, package? }. For api: { base_url, allowed_hosts: string[], auth: { placement: "header"|"query", name, scheme? }, docs_url? }.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			// name non-empty enforced by the schema; kind is a schema enum.
			const name = (args.name as string).trim();
			const kind = args.kind as 'saas' | 'local' | 'api';
			let config = args.config as Record<string, unknown>;

			if (kind === 'saas') {
				if (!config?.url || typeof config.url !== 'string') {
					return { error: 'saas connections require config.url (string)' };
				}
			} else if (kind === 'api') {
				const validated = validateApiConnectorConfig(config);
				if (!validated.ok) return { error: validated.error };
				config = validated.config as unknown as Record<string, unknown>;
			} else {
				if (!config?.command || typeof config.command !== 'string') {
					return { error: 'local connections require config.command (string)' };
				}
			}

			// api behaves like saas for install state (nothing to install — it's a
			// direct REST call); only local needs an installer pass.
			const initialStatus = kind === 'local' ? 'pending' : 'installed';
			const r = await db.query<{
				id: string;
				install_status: string;
			}>(
				`INSERT INTO mcp_connections (name, kind, config, install_status, project_id)
				 VALUES ($1, $2::mcp_connection_kind, $3::jsonb, $4::mcp_install_status, $5)
				 ON CONFLICT (project_id, name) WHERE project_id IS NOT NULL DO UPDATE
				 SET kind = EXCLUDED.kind,
				     config = EXCLUDED.config,
				     install_status = EXCLUDED.install_status,
				     install_error = NULL,
				     updated_at = now()
				 RETURNING id, install_status::text AS install_status`,
				[name, kind, JSON.stringify(config), initialStatus, scope.projectId],
			);
			const note =
				kind === 'local'
					? 'Local MCP registered with status pending. Install via the installer or container provision before agent runs can use it.'
					: kind === 'api'
						? 'API connector registered. Attach a credential (Connectors page → API key), then call list_connectors to get its api_auth placeholder + base_url.'
						: 'SaaS MCP registered. Will be available to the next agent run in this scope.';
			return {
				id: r.rows[0].id,
				install_status: r.rows[0].install_status,
				note,
			};
		},
		db,
	);

	tool(
		server,
		'remove_connector',
		'Remove one of your project\'s registered MCP connections. Only connectors owned by your project can be removed — global "all projects" connectors and other projects\' are managed elsewhere. The next agent run will not see it.',
		{
			project: projectArg(),
			id: z
				.string()
				.describe('connector id or name (returned by add_connector or list_connectors)'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const r = await db.query<{ id: string }>(
				'DELETE FROM mcp_connections WHERE (id::text = $1 OR name = $1) AND project_id = $2 RETURNING id',
				[args.id as string, scope.projectId],
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
async function canCoordinateTeam(db: Db, auth: AuthInfo, teamId: string): Promise<boolean> {
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
